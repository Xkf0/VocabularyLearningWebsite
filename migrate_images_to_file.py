#!/usr/bin/env python3
"""
迁移已有的 base64 图片到文件存储。

做法：
1. 备份所有 vocabulary-data-*.json 文件到 .bak
2. 扫描所有 base64 图片，保存到 images/ 目录
3. 将 JSON 中的 base64 字符串替换为 { file, data } 格式（data 就是原 base64，作为兜底）
4. 保存更新后的 JSON

安全保证：
- 先备份，再修改
- 绝不删除 base64 数据（data 字段保留原值）
- 如果某个图片保存失败，保持原字段不变
- 可重复运行（已转换的 {file,data} 跳过）
"""
import json, os, re, base64, uuid, shutil, sys
from datetime import datetime

DATA_DIR = os.path.dirname(os.path.abspath(__file__))
IMAGE_DIR = os.path.join(DATA_DIR, 'images')
BACKUP_SUFFIX = '.bak'

# 需要扫描的字段及取值路径
# (父字段, 子字段, 是否为数组, key_field_for_single)
IMAGE_SCAN_RULES = [
    # mathProblems 中的字段
    ('mathProblems', 'titleImage', True, None),
    ('mathProblems', 'solutionImages', True, None),
    ('mathProblems', 'images', True, None),  # 旧 legacy 字段
    # problems 中的字段
    ('problems', 'questionImage', True, None),
    ('problems', 'solutionImages', True, None),
    ('problems', 'images', True, None),  # 旧 legacy 字段
    # methods 中的字段
    ('methods', 'images', True, None),
    # items 中的 images 字段（如 practiceHistory 中的 images）
]


def is_base64_dataurl(val):
    """检查是否为 base64 data URL 字符串"""
    return bool(re.match(r'^data:image/[^;]+;base64,', val)) if isinstance(val, str) else False


def save_base64_to_file(dataurl):
    """将 base64 data URL 保存为文件，返回文件名（不含路径）。失败返回 None。"""
    try:
        m = re.match(r'^data:image/([^;]+);base64,(.+)$', dataurl)
        if not m:
            return None
        ext = m.group(1).replace('jpeg', 'jpg')
        raw = base64.b64decode(m.group(2))
        filename = str(uuid.uuid4()) + '.' + ext
        filepath = os.path.join(IMAGE_DIR, filename)
        with open(filepath, 'wb') as f:
            f.write(raw)
        return filename
    except Exception as e:
        print(f'    [ERROR] 保存图片失败: {e}', file=sys.stderr)
        return None


def transform_image_value(val, stats):
    """
    转换单个图片值。
    - 如果是 base64 字符串 -> 存文件，返回 { file, data }
    - 如果是 {file, data} 对象且文件存在 -> 跳过（已转换）
    - 否则 -> 返回原值
    """
    if isinstance(val, str) and is_base64_dataurl(val):
        filename = save_base64_to_file(val)
        if filename:
            stats['saved'] += 1
            stats['bytes_saved'] += len(val)
            print(f'    ✓ 已保存: {filename} ({(len(val) / 1024):.0f}KB)')
            return {'file': filename, 'data': val}
        else:
            stats['failed'] += 1
            print(f'    ✗ 保存失败，保留原值')
            return val

    # 已经是 { file, data } 格式，检查文件是否存在
    if isinstance(val, dict) and 'file' in val and 'data' in val:
        filepath = os.path.join(IMAGE_DIR, val['file'])
        if os.path.exists(filepath):
            stats['skipped'] += 1
        else:
            # 文件丢失，重新保存
            print(f'    ! 文件丢失，重新保存: {val["file"]}')
            if val.get('data') and is_base64_dataurl(val['data']):
                filename = save_base64_to_file(val['data'])
                if filename:
                    val['file'] = filename
                    stats['saved'] += 1
                    print(f'    ✓ 已重新保存: {filename}')
                else:
                    stats['failed'] += 1

    return val


def transform_field(items, field_name, is_array=True, stats=None):
    """转换某个字段下的所有图片"""
    if stats is None:
        stats = {'saved': 0, 'skipped': 0, 'failed': 0}
    for item in items:
        val = item.get(field_name)
        if not val:
            continue

        if is_array and isinstance(val, list):
            new_list = []
            changed = False
            for v in val:
                new_v = transform_image_value(v, stats)
                new_list.append(new_v)
                if new_v is not v:
                    changed = True
            if changed:
                item[field_name] = new_list
        elif not is_array:
            new_val = transform_image_value(val, stats)
            if new_val is not val:
                item[field_name] = new_val

    return stats


def scan_practice_history(items, stats):
    """扫描 practiceHistory 中的 images 字段"""
    for item in items:
        history = item.get('practiceHistory', [])
        if not history:
            continue
        for entry in history:
            images = entry.get('images', [])
            if not images or not isinstance(images, list):
                continue
            new_images = []
            changed = False
            for v in images:
                new_v = transform_image_value(v, stats)
                new_images.append(new_v)
                if new_v is not v:
                    changed = True
            if changed:
                entry['images'] = new_images


def migrate_user_file(filepath):
    """处理单个用户的 JSON 文件"""
    print(f'\n处理: {os.path.basename(filepath)}')
    if not os.path.exists(filepath):
        print('  文件不存在，跳过')
        return

    # 读取数据
    with open(filepath, 'r', encoding='utf-8') as f:
        try:
            data = json.load(f)
        except json.JSONDecodeError as e:
            print(f'  [ERROR] JSON 解析失败: {e}')
            return

    stats = {'saved': 0, 'skipped': 0, 'failed': 0}

    # 扫描各个字段
    for section, field, is_array, _ in IMAGE_SCAN_RULES:
        items = data.get(section, [])
        if not items:
            continue
        print(f'  扫描 {section}.{field} ({len(items)} 条)...')
        transform_field(items, field, is_array, stats)

    # 扫描 practiceHistory
    for section, _, _, _ in IMAGE_SCAN_RULES:
        items = data.get(section, [])
        if items:
            scan_practice_history(items, stats)

    # 扫描 avatar
    avatar = data.get('avatar', '')
    if avatar and is_base64_dataurl(avatar):
        filename = save_base64_to_file(avatar)
        if filename:
            data['avatar'] = {'file': filename, 'data': avatar}
            stats['saved'] += 1
            print(f'  avatar ✓ 已保存: {filename}')
        else:
            stats['failed'] += 1

    if stats['saved'] == 0 and stats['failed'] == 0:
        print('  无需修改')
        return

    # 备份原文件
    backup_path = filepath + BACKUP_SUFFIX
    shutil.copy2(filepath, backup_path)
    print(f'  备份: {backup_path}')

    # 保存更新后的数据
    with open(filepath, 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    print(f'  保存: {os.path.basename(filepath)}')
    print(f'  统计: 新增 {stats["saved"]} 张, 跳过 {stats["skipped"]} 张, 失败 {stats["failed"]} 张')

    return stats


def main():
    print('=' * 60)
    print('  迁移 base64 图片到文件存储')
    print(f'  数据目录: {DATA_DIR}')
    print(f'  图片目录: {IMAGE_DIR}')
    print(f'  备份后缀: {BACKUP_SUFFIX}')
    print('=' * 60)

    # 创建图片目录
    os.makedirs(IMAGE_DIR, exist_ok=True)

    # 查找所有用户数据文件
    total_saved = 0
    total_failed = 0
    total_files = 0

    for filename in sorted(os.listdir(DATA_DIR)):
        if not filename.startswith('vocabulary-data-') or not filename.endswith('.json'):
            continue
        if filename.endswith(BACKUP_SUFFIX):
            continue
        filepath = os.path.join(DATA_DIR, filename)
        result = migrate_user_file(filepath)
        if result:
            total_files += 1
            total_saved += result['saved']
            total_failed += result['failed']

    print('\n' + '=' * 60)
    print(f'  迁移完成!')
    print(f'  处理文件: {total_files}')
    print(f'  新增图片: {total_saved}')
    print(f'  失败: {total_failed}')
    if total_saved > 0:
        print(f'\n  注意: base64 数据已保留在 data 字段中作为兜底。')
        print(f'  确认图片显示正常后，可手动清理 data 字段以减小 JSON 体积。')
    print('=' * 60)


if __name__ == '__main__':
    main()
