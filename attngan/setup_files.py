"""
One-time download and preparation of the AttnGAN files from the official AttnGAN repository (github.com/taoxugit/AttnGAN, MIT).
Extracts the text encoders, turns the vocabulary pickles into plain JSON (read with a restricted unpickler that cannot
run code) and re-saves the networks as plain tensor files. Run: venv\\Scripts\\python.exe attngan\\setup_files.py
"""
import os, io, json, pickle, zipfile
import torch

HERE = os.path.dirname(os.path.abspath(__file__))
DL = os.path.join(HERE, "downloads")
# Google Drive file ids from the AttnGAN README (metadata, DAMSM text encoders, generators)
DOWNLOADS = {
    "birds_meta.zip": "1O_LtUP9sch09QH3s_EBAgLEctBQ5JBSJ",
    "coco_meta.zip": "1rSnbIGNDGZeHlsUlLdahj0RJ9oo6lgH9",
    "bird_damsm.zip": "1GNUKjVeyWYBJ8hEU-yrfYQpDOkxEyP3V",
    "coco_damsm.zip": "1zIrXCE9F6yfbEJIbNP5-YrEe2pZcPSGJ",
    "bird_AttnGAN2.pth": "1lqNG75suOuR_8gjoEPYNp8VyT_ufPPig",
    "coco_AttnGAN2.pth": "1i9Xkg9nU74RAvkcqKE-rJYhjvzKAMnCi",
}


def download_missing():
    """Fetch the original files (~315 MB) into attngan\\downloads unless they are already there."""
    os.makedirs(DL, exist_ok=True)
    missing = [n for n in DOWNLOADS if not os.path.exists(os.path.join(DL, n))]
    if not missing:
        return
    try:
        import gdown
    except ImportError:
        raise SystemExit("Downloading needs gdown: venv\\Scripts\\python.exe -m pip install gdown")
    for name in missing:
        print("Downloading", name)
        if not gdown.download(id=DOWNLOADS[name], output=os.path.join(DL, name), quiet=False):
            raise SystemExit(f"Download of {name} failed - try again later (Google Drive limits busy files).")


class DataOnly(pickle.Unpickler):
    """Allows only plain data (lists, dicts, strings, numbers); refuses to build any class."""
    def find_class(self, module, name):
        raise pickle.UnpicklingError(f"refusing to load {module}.{name}")


def vocab(zip_name, member, out):
    with zipfile.ZipFile(os.path.join(DL, zip_name)) as z:
        data = DataOnly(io.BytesIO(z.read(member)), encoding="latin1").load()
    ixtoword, wordtoix = data[2], data[3]
    words = [ixtoword[i] for i in range(len(ixtoword))]
    with open(os.path.join(HERE, out), "w", encoding="utf-8") as fh:
        json.dump({"words": words}, fh)
    print(f"{out}: {len(words)} words")


def weights(src, out, zip_name=None):
    raw = zipfile.ZipFile(os.path.join(DL, zip_name)).read(src) if zip_name else open(os.path.join(DL, src), "rb").read()
    sd = torch.load(io.BytesIO(raw), map_location="cpu", weights_only=True)
    torch.save({k: v.clone() for k, v in sd.items()}, os.path.join(HERE, out))
    print(f"{out}: {len(sd)} tensors, {sum(v.numel() for v in sd.values()) / 1e6:.1f} M values")


if __name__ == "__main__":
    download_missing()
    vocab("birds_meta.zip", "birds/captions.pickle", "birds_vocab.json")
    vocab("coco_meta.zip", "coco/captions.pickle", "coco_vocab.json")
    weights("bird/text_encoder200.pth", "birds_text_encoder.pth", "bird_damsm.zip")
    weights("coco/text_encoder100.pth", "coco_text_encoder.pth", "coco_damsm.zip")
    weights("bird_AttnGAN2.pth", "birds_generator.pth")
    weights("coco_AttnGAN2.pth", "coco_generator.pth")
