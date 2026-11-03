# Prints macOS's own emoji search data as JSON for the picker: the emoji in the system's order,
# their names, and each search term's emoji, best match first. Read from CoreEmoji, so it is
# the same search the system picker does and follows OS updates.
import json
import plistlib
import sys

ROOT = "/System/Library/PrivateFrameworks/CoreEmoji.framework/Versions/A/Resources/"
LANG = sys.argv[1] if len(sys.argv) > 1 else "en"
SKIN = set(range(0x1F3FB, 0x1F400))


def emoji_list():
    # emojimeta.dat holds the system's emoji as one NUL-separated UTF-8 run; the search
    # index numbers them from 1 in that order.
    text = open(ROOT + "emojimeta.dat", "rb").read().decode("utf-8", "ignore")
    at = text.find("\U0001F600")
    part = lambda c: c == "\x00" or ord(c) > 0x7F or c in "#*0123456789"
    start = end = at
    while start > 0 and part(text[start - 1]):
        start -= 1
    while end < len(text) and part(text[end]):
        end += 1
    return [e for e in text[start:end].split("\x00") if e]


def load(name):
    with open(ROOT + name, "rb") as f:
        return plistlib.load(f)


items = emoji_list()
names = load(f"{LANG}.lproj/AppleName.strings")
terms_in = load(f"SearchModel-{LANG}/term_index.plist")
docs = load(f"SearchModel-{LANG}/document_index.plist")

terms = {}
for term, ids in terms_in.items():
    ranked = []
    for i in ids:
        e = items[i - 1] if 0 < i <= len(items) else None
        # Skin-tone variants crowd every people search; the base emoji stands for them.
        if not e or any(ord(c) in SKIN for c in e):
            continue
        ranked.append((-(docs.get(str(i), {}).get(term, {}).get("w", 0)), i - 1))
    if ranked:
        terms[term] = [i for _, i in sorted(ranked)]

json.dump({"items": items, "names": names, "terms": terms}, sys.stdout, ensure_ascii=False, separators=(",", ":"))
