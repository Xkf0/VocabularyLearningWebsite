#!/usr/bin/env python3
"""Migrate existing images to smaller size: max 800px, JPEG quality 0.6."""
import json, os, re, base64, io, sys
from PIL import Image

DATA_FILE = '/root/vocabulary-data-XIEFAN.json'
BACKUP_FILE = DATA_FILE + '.bak'
MAX_SIZE = 800
QUALITY = 60

# Fields that may contain images (string or list of strings)
IMAGE_FIELDS = ['questionImage', 'titleImage', 'answerImage', 'image']
LIST_IMAGE_FIELDS = ['solutionImages']

def compress_dataurl(dataurl):
    """Compress a data URL image. Returns None if no change, or (new_dataurl, old_bytes, new_bytes)."""
    m = re.match(r'^data:image/[^;]+;base64,(.+)$', dataurl)
    if not m:
        return None
    try:
        raw = base64.b64decode(m.group(1))
        img = Image.open(io.BytesIO(raw))
    except Exception:
        return None

    w, h = img.size

    # Skip if already small (under 20KB) and not too large in dimensions
    if w <= MAX_SIZE and h <= MAX_SIZE and len(raw) < 20000:
        return None

    # Resize if needed
    if w > MAX_SIZE or h > MAX_SIZE:
        scale = min(MAX_SIZE / w, MAX_SIZE / h)
        new_w = int(w * scale)
        new_h = int(h * scale)
        img = img.resize((new_w, new_h), Image.LANCZOS)

    # Convert to RGB if needed (for JPEG)
    if img.mode != 'RGB':
        img = img.convert('RGB')

    buf = io.BytesIO()
    img.save(buf, 'JPEG', quality=QUALITY)
    compressed = base64.b64encode(buf.getvalue()).decode('ascii')
    old_len = len(raw)
    new_len = len(compressed)
    return (f'data:image/jpeg;base64,{compressed}', old_len, new_len)

def process_item_images(item, path_prefix):
    """Process all image fields in an item. Returns (changed, old_bytes, new_bytes)."""
    changed = False
    old_total = 0
    new_total = 0

    # Process string image fields
    for field in IMAGE_FIELDS:
        val = item.get(field)
        if not val:
            continue
        if isinstance(val, str):
            result = compress_dataurl(val)
            if result:
                new_url, old_sz, new_sz = result
                item[field] = new_url
                changed = True
                old_total += old_sz
                new_total += new_sz
                print(f'  {path_prefix}.{field}: {old_sz} -> {new_sz} bytes ({100*new_sz//old_sz}%)')

    # Process list image fields (both IMAGE_FIELDS and LIST_IMAGE_FIELDS)
    all_list_fields = [f for f in IMAGE_FIELDS if isinstance(item.get(f), list)] + \
                      [f for f in LIST_IMAGE_FIELDS if isinstance(item.get(f), list)]

    for field in all_list_fields:
        val = item.get(field)
        if not val or not isinstance(val, list):
            continue
        new_list = []
        field_changed = False
        for i, v in enumerate(val):
            if isinstance(v, str):
                result = compress_dataurl(v)
                if result:
                    new_url, old_sz, new_sz = result
                    new_list.append(new_url)
                    field_changed = True
                    old_total += old_sz
                    new_total += new_sz
                    print(f'  {path_prefix}.{field}[{i}]: {old_sz} -> {new_sz} bytes ({100*new_sz//old_sz}%)')
                else:
                    new_list.append(v)
            else:
                new_list.append(v)
        if field_changed:
            item[field] = new_list
            changed = True

    return changed, old_total, new_total

def main():
    if not os.path.exists(DATA_FILE):
        print(f'Data file not found: {DATA_FILE}')
        return

    print(f'Loading {DATA_FILE}...')
    with open(DATA_FILE, 'r') as f:
        data = json.load(f)

    total_old = 0
    total_new = 0
    total_changed = 0

    for section in ['problems', 'mathProblems']:
        items = data.get(section, [])
        if not items:
            continue
        print(f'\nProcessing {section}: {len(items)} items')
        for i, item in enumerate(items):
            changed, old_sz, new_sz = process_item_images(item, f'{section}[{i}]')
            if changed:
                total_changed += 1
                total_old += old_sz
                total_new += new_sz

    # Also check avatar
    avatar = data.get('avatar', '')
    if avatar and avatar.startswith('data:image/'):
        result = compress_dataurl(avatar)
        if result:
            new_url, old_sz, new_sz = result
            data['avatar'] = new_url
            total_changed += 1
            total_old += old_sz
            total_new += new_sz
            print(f'\n  avatar: {old_sz} -> {new_sz} bytes ({100*new_sz//old_sz}%)')

    if total_changed == 0:
        print('\nNo images to compress.')
        return

    savings = total_old - total_new
    pct = 100 * savings // total_old if total_old > 0 else 0
    print(f'\nTotal: {total_changed} items changed, {total_old} -> {total_new} bytes (saved {savings} bytes, {pct}%)')

    # Backup original
    os.rename(DATA_FILE, BACKUP_FILE)
    print(f'Backup saved to {BACKUP_FILE}')

    # Write compressed data
    with open(DATA_FILE, 'w') as f:
        json.dump(data, f, ensure_ascii=False)
    print(f'Compressed data saved to {DATA_FILE}')

    # Check file sizes
    orig_size = os.path.getsize(BACKUP_FILE)
    new_size = os.path.getsize(DATA_FILE)
    print(f'File size: {orig_size} -> {new_size} bytes ({100*new_size//orig_size}%)')

if __name__ == '__main__':
    main()
