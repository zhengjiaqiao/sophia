#!/usr/bin/env python3
"""逐项比对两棵目录树（backup.sh / restore.sh 的核对用）。

用法：treecmp.py <甲> <乙> [<甲2> <乙2> …]
  每一对：两边要有同一组相对路径、同一种类型；普通文件比大小与 SHA-256，软链比指向（readlink，不跟随），
  普通文件与目录还比权限位（cp -p / 克隆都会保留）。甲不存在时要求乙也不存在。
  任何枚举（列目录）、stat、readlink、读文件失败都算不一致并列出路径：核对不了不等于一致。
  只读，不改任何东西。全部一致退出 0；有差异打印前 20 处并退出 1。
"""
import hashlib
import os
import stat
import sys

LIMIT = 20


def digest(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def entries(root, errors):
    """相对路径 → (类型, 权限位, 大小或指向)；不跟随软链。列不出的目录、stat / readlink 失败记进 errors"""
    out = {}
    def walk_error(e):
        errors.append(f"{e.filename}：列不出目录内容（{e.strerror}），无法核对")
    for dp, dns, fns in os.walk(root, followlinks=False, onerror=walk_error):
        for n in dns + fns:
            p = os.path.join(dp, n)
            rel = os.path.relpath(p, root)
            try:
                st = os.lstat(p)
                link = os.readlink(p) if stat.S_ISLNK(st.st_mode) else None
            except OSError as e:
                errors.append(f"{p}：读不了属性（{e.strerror}），无法核对")
                out[rel] = ("读不了", None, None)
                continue
            if stat.S_ISLNK(st.st_mode):
                out[rel] = ("软链", None, link)
            elif stat.S_ISDIR(st.st_mode):
                out[rel] = ("目录", stat.S_IMODE(st.st_mode), None)
            elif stat.S_ISREG(st.st_mode):
                out[rel] = ("文件", stat.S_IMODE(st.st_mode), st.st_size)
            else:
                out[rel] = ("其他", None, None)
    return out


def compare(a, b, diffs):
    files = 0
    if not os.path.lexists(a):
        if os.path.lexists(b):
            diffs.append(f"{b}：甲（{a}）不存在，乙却存在")
        return 0
    if not os.path.isdir(b) or os.path.islink(b):
        diffs.append(f"{b}：不存在或不是目录")
        return 0
    try:
        ra, rb = os.lstat(a), os.lstat(b)
    except OSError as e:
        diffs.append(f"{e.filename}：读不了属性（{e.strerror}），无法核对")
        return 0
    if stat.S_IMODE(ra.st_mode) != stat.S_IMODE(rb.st_mode):
        diffs.append(f"{b}：根目录权限 {oct(stat.S_IMODE(ra.st_mode))} → {oct(stat.S_IMODE(rb.st_mode))}")
    ea, eb = entries(a, diffs), entries(b, diffs)
    for rel in sorted(set(ea) - set(eb)):
        diffs.append(f"{os.path.join(b, rel)}：甲有、乙没有")
    for rel in sorted(set(eb) - set(ea)):
        diffs.append(f"{os.path.join(b, rel)}：乙多出来的")
    for rel in sorted(set(ea) & set(eb)):
        (ta, ma, xa), (tb, mb, xb) = ea[rel], eb[rel]
        where = os.path.join(b, rel)
        if "读不了" in (ta, tb):
            continue  # 已在 entries 里记过
        if ta != tb:
            diffs.append(f"{where}：类型 {ta} → {tb}")
            continue
        if ma != mb:
            diffs.append(f"{where}：权限 {oct(ma)} → {oct(mb)}")
        if ta == "软链" and xa != xb:
            diffs.append(f"{where}：软链指向 {xa!r} → {xb!r}")
        elif ta == "文件":
            files += 1
            if xa != xb:
                diffs.append(f"{where}：大小 {xa} → {xb}")
                continue
            try:
                if digest(os.path.join(a, rel)) != digest(where):
                    diffs.append(f"{where}：内容不同（SHA-256）")
            except OSError as e:
                diffs.append(f"{where}：读不了（{e.strerror}）")
    return files


def main(argv):
    if len(argv) < 2 or len(argv) % 2:
        sys.exit(__doc__)
    diffs = []
    for a, b in zip(argv[0::2], argv[1::2]):
        before = len(diffs)
        n = compare(a, b, diffs)
        state = "一致" if len(diffs) == before else f"不一致！（{len(diffs) - before} 处）"
        print(f"    {b}：逐个比了 {n} 个文件的内容 → {state}")
    for d in diffs[:LIMIT]:
        print(f"      {d}")
    if len(diffs) > LIMIT:
        print(f"      ……另有 {len(diffs) - LIMIT} 处")
    return 1 if diffs else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
