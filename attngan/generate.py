"""
AttnGAN text-to-image (Xu et al., CVPR 2018), ported to current PyTorch for inference only.
Network code adapted from github.com/taoxugit/AttnGAN (MIT licence, Copyright (c) 2018 Tao Xu).

    venv\\Scripts\\python.exe attngan\\generate.py --dataset birds --seed 1 --count 4 --out DIR "a red bird with black wings"

Writes into DIR, for every variation i:
    i_stage1_64.png, i_stage2_128.png, i_stage3_256.png   the three generator stages (coarse to fine)
    i_attention.png                                        which word shaped which part of the final stage
and result.json (words used / ignored, file list). Run attngan\\setup_files.py once first.
"""
import os, re, sys, json, argparse
import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F
from torch.nn.utils.rnn import pack_padded_sequence, pad_packed_sequence

HERE = os.path.dirname(os.path.abspath(__file__))
CONFIGS = {   # from the repository's eval_bird.yml / eval_coco.yml
    "birds": dict(gf_dim=32, r_num=2, words_num=25),
    "coco": dict(gf_dim=48, r_num=3, words_num=20),
}
Z_DIM, EMB_DIM, COND_DIM = 100, 256, 100


# ----------------------------------------------------------------------------- networks
class GLU(nn.Module):
    def forward(self, x):
        n = x.size(1) // 2
        return x[:, :n] * torch.sigmoid(x[:, n:])


def conv3x3(i, o):
    return nn.Conv2d(i, o, 3, 1, 1, bias=False)


def up_block(i, o):
    return nn.Sequential(nn.Upsample(scale_factor=2, mode="nearest"), conv3x3(i, o * 2), nn.BatchNorm2d(o * 2), GLU())


class ResBlock(nn.Module):
    def __init__(self, c):
        super().__init__()
        self.block = nn.Sequential(conv3x3(c, c * 2), nn.BatchNorm2d(c * 2), GLU(), conv3x3(c, c), nn.BatchNorm2d(c))

    def forward(self, x):
        return x + self.block(x)


class RNN_ENCODER(nn.Module):
    def __init__(self, ntoken, ninput=300, nhidden=EMB_DIM):
        super().__init__()
        self.encoder = nn.Embedding(ntoken, ninput)
        self.drop = nn.Dropout(0.5)
        self.nhidden = nhidden // 2
        self.rnn = nn.LSTM(ninput, self.nhidden, 1, batch_first=True, bidirectional=True)

    def forward(self, captions, cap_lens):
        emb = self.drop(self.encoder(captions))
        packed = pack_padded_sequence(emb, cap_lens.cpu(), batch_first=True, enforce_sorted=False)
        out, (h, _) = self.rnn(packed)
        out = pad_packed_sequence(out, batch_first=True, total_length=captions.size(1))[0]
        words_emb = out.transpose(1, 2)                                  # batch x 256 x seq
        sent_emb = h.transpose(0, 1).contiguous().view(-1, self.nhidden * 2)
        return words_emb, sent_emb


class CA_NET(nn.Module):
    def __init__(self):
        super().__init__()
        self.fc = nn.Linear(EMB_DIM, COND_DIM * 4, bias=True)
        self.relu = GLU()

    def forward(self, t, gen):
        x = self.relu(self.fc(t))
        mu, logvar = x[:, :COND_DIM], x[:, COND_DIM:]
        eps = torch.randn(mu.shape, generator=gen, device="cpu").to(mu.device)
        return eps * logvar.mul(0.5).exp() + mu


class INIT_STAGE_G(nn.Module):
    def __init__(self, ngf):
        super().__init__()
        self.gf_dim = ngf
        self.fc = nn.Sequential(nn.Linear(Z_DIM + COND_DIM, ngf * 4 * 4 * 2, bias=False), nn.BatchNorm1d(ngf * 4 * 4 * 2), GLU())
        self.upsample1 = up_block(ngf, ngf // 2)
        self.upsample2 = up_block(ngf // 2, ngf // 4)
        self.upsample3 = up_block(ngf // 4, ngf // 8)
        self.upsample4 = up_block(ngf // 8, ngf // 16)

    def forward(self, z, c):
        x = self.fc(torch.cat((c, z), 1)).view(-1, self.gf_dim, 4, 4)
        return self.upsample4(self.upsample3(self.upsample2(self.upsample1(x))))


class ATT_NET(nn.Module):
    def __init__(self, idf, cdf):
        super().__init__()
        self.conv_context = nn.Conv2d(cdf, idf, 1, 1, 0, bias=False)

    def forward(self, x, context, mask):
        b, _, ih, iw = x.shape
        q = x.view(b, -1, ih * iw).transpose(1, 2)                         # b x queryL x idf
        src = self.conv_context(context.unsqueeze(3)).squeeze(3)           # b x idf x sourceL
        attn = torch.bmm(q, src)                                           # b x queryL x sourceL
        attn = attn.masked_fill(mask.unsqueeze(1), float("-inf")).softmax(-1)
        attn = attn.transpose(1, 2)                                        # b x sourceL x queryL
        weighted = torch.bmm(src, attn).view(b, -1, ih, iw)
        return weighted, attn.reshape(b, -1, ih, iw)


class NEXT_STAGE_G(nn.Module):
    def __init__(self, ngf, nef, r_num):
        super().__init__()
        self.att = ATT_NET(ngf, nef)
        self.residual = nn.Sequential(*[ResBlock(ngf * 2) for _ in range(r_num)])
        self.upsample = up_block(ngf * 2, ngf)

    def forward(self, h, words, mask):
        c, att = self.att(h, words, mask)
        return self.upsample(self.residual(torch.cat((h, c), 1))), att


class GET_IMAGE_G(nn.Module):
    def __init__(self, ngf):
        super().__init__()
        self.img = nn.Sequential(conv3x3(ngf, 3), nn.Tanh())

    def forward(self, h):
        return self.img(h)


class G_NET(nn.Module):
    def __init__(self, gf_dim, r_num):
        super().__init__()
        self.ca_net = CA_NET()
        self.h_net1 = INIT_STAGE_G(gf_dim * 16); self.img_net1 = GET_IMAGE_G(gf_dim)
        self.h_net2 = NEXT_STAGE_G(gf_dim, EMB_DIM, r_num); self.img_net2 = GET_IMAGE_G(gf_dim)
        self.h_net3 = NEXT_STAGE_G(gf_dim, EMB_DIM, r_num); self.img_net3 = GET_IMAGE_G(gf_dim)

    def forward(self, z, sent, words, mask, gen):
        c = self.ca_net(sent, gen)
        h1 = self.h_net1(z, c)
        h2, att1 = self.h_net2(h1, words, mask)
        h3, att2 = self.h_net3(h2, words, mask)
        return [self.img_net1(h1), self.img_net2(h2), self.img_net3(h3)], att2


# ----------------------------------------------------------------------------- generation
def tokenize(text, vocab_index):
    used, ignored = [], []
    for t in re.findall(r"\w+", text.lower()):
        t = t.encode("ascii", "ignore").decode("ascii")
        if t:
            (used if t in vocab_index else ignored).append(t)
    return used, ignored


def to_pil(t):
    from PIL import Image
    a = ((t.clamp(-1, 1) + 1) * 127.5).round().byte().permute(1, 2, 0).cpu().numpy()
    return Image.fromarray(a)


def attention_sheet(img256, att, words):
    """One tile per word: the final image tinted where that word's attention is strongest."""
    from PIL import Image, ImageDraw
    base = np.asarray(img256.resize((160, 160))).astype(np.float32) / 255
    tiles = []
    for k, w in enumerate(words):
        a = att[k].float().cpu().numpy()
        a = (a - a.min()) / (a.max() - a.min() + 1e-8)
        a = np.asarray(Image.fromarray((a * 255).astype(np.uint8)).resize((160, 160), Image.BILINEAR)).astype(np.float32) / 255
        tile = base * (0.25 + 0.75 * a[..., None]) + np.array([0.25, 0.85, 0.8]) * 0.35 * a[..., None]
        im = Image.fromarray((np.clip(tile, 0, 1) * 255).astype(np.uint8))
        lab = Image.new("RGB", (160, 22), (20, 22, 28)); ImageDraw.Draw(lab).text((6, 5), w, fill=(230, 230, 230))
        col = Image.new("RGB", (160, 182)); col.paste(lab, (0, 0)); col.paste(im, (0, 22))
        tiles.append(col)
    cols = min(6, len(tiles)); rows = (len(tiles) + cols - 1) // cols
    sheet = Image.new("RGB", (cols * 164, rows * 186), (13, 15, 19))
    for i, t in enumerate(tiles):
        sheet.paste(t, ((i % cols) * 164, (i // cols) * 186))
    return sheet


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("prompt")
    ap.add_argument("--dataset", choices=list(CONFIGS), default="birds")
    ap.add_argument("--seed", type=int, default=1)
    ap.add_argument("--count", type=int, default=4)
    ap.add_argument("--out", required=True)
    a = ap.parse_args()
    cfgd = CONFIGS[a.dataset]
    os.makedirs(a.out, exist_ok=True)
    files = {k: os.path.join(HERE, f"{a.dataset}_{k}") for k in ("vocab.json", "text_encoder.pth", "generator.pth")}
    if not all(os.path.exists(p) for p in files.values()):
        sys.exit("AttnGAN files missing - run venv\\Scripts\\python.exe attngan\\setup_files.py first.")
    words = json.load(open(files["vocab.json"], encoding="utf-8"))["words"]
    index = {w: i for i, w in enumerate(words)}
    used, ignored = tokenize(a.prompt, index)
    if not used:
        sys.exit(f"None of the words are in the {a.dataset} vocabulary ({len(words)} words). "
                 + ("The birds model knows bird descriptions: colours, beaks, wings, breast, crown..." if a.dataset == "birds"
                    else "Try plain English nouns and adjectives."))
    dev = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    enc = RNN_ENCODER(len(words)); enc.load_state_dict(torch.load(files["text_encoder.pth"], weights_only=True)); enc.eval().to(dev)
    gnet = G_NET(cfgd["gf_dim"], cfgd["r_num"]); gnet.load_state_dict(torch.load(files["generator.pth"], weights_only=True)); gnet.eval().to(dev)
    n = max(1, min(8, a.count))
    caps = torch.tensor([[index[w] for w in used]] * n, device=dev)
    lens = torch.tensor([len(used)] * n)
    gen = torch.Generator(device="cpu").manual_seed(a.seed)
    with torch.no_grad():
        word_emb, sent_emb = enc(caps, lens)
        mask = caps == 0
        z = torch.randn(n, Z_DIM, generator=gen).to(dev)
        imgs, att = gnet(z, sent_emb, word_emb, mask, gen)
    out = []
    for i in range(n):
        names = {}
        for s, (t, size) in enumerate(zip(imgs, (64, 128, 256)), 1):
            p = os.path.join(a.out, f"{i}_stage{s}_{size}.png"); to_pil(t[i]).save(p); names[f"stage{s}"] = os.path.basename(p)
        p = os.path.join(a.out, f"{i}_attention.png")
        attention_sheet(to_pil(imgs[2][i]), att[i, :len(used)], used).save(p); names["attention"] = os.path.basename(p)
        out.append(names)
    res = dict(prompt=a.prompt, dataset=a.dataset, seed=a.seed, used=used, ignored=ignored, images=out)
    with open(os.path.join(a.out, "result.json"), "w", encoding="utf-8") as fh:
        json.dump(res, fh)
    print(f"Generated {n} images from: {' '.join(used)}" + (f"  (unknown words ignored: {', '.join(ignored)})" if ignored else ""))


if __name__ == "__main__":
    main()
