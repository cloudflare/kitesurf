#!/usr/bin/env python3
# Copyright (c) 2026 Cloudflare, Inc.
# Licensed under the Apache 2.0 license found in the LICENSE file or at:
# https://opensource.org/licenses/Apache-2.0

import sys
from fontTools.ttLib import TTFont


def main() -> int:
    if len(sys.argv) != 3:
        print("usage: strip-emoji-svg.py <src.woff2> <dst.woff2>", file=sys.stderr)
        return 2
    src, dst = sys.argv[1], sys.argv[2]
    font = TTFont(src)
    had_svg = "SVG " in font
    if had_svg:
        del font["SVG "]
    font.flavor = "woff2"
    font.save(dst)
    tables = [t for t in font.keys() if t != "GlyphOrder"]
    print(f"strip-emoji-svg: SVG {'removed' if had_svg else 'absent'} -> {dst}")
    print(f"  tables: {tables}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
