#!/usr/bin/env python3
"""Turn a text-based PDF into markdown the site builder can render.

Usage:
  python3 scripts/pdf_to_md.py <file.pdf> <body.md>
"""

import re
import sys

from pypdf import PdfReader

TABLE_6 = """
Table 6. Strategic decarbonization and clean air capital deployment, 2026–2040.

| Target sector | Phase 1 (2026–2030) | Phase 2 (2031–2035) | Phase 3 (2036–2040) | Estimated capital | Cumulative health return |
| --- | --- | --- | --- | --- | --- |
| Household clean cooking | LPG and induction, 50% shift | Universal clean fuel access | Fully electrified cooking grids | $115 billion | 14.2 million avoided mortalities |
| Heavy industry and kilns | Zig-zag brick kiln retrofit | Scrubber mandates on cement | Hydrogen direct-reduced iron | $340 billion | 8.6 million avoided mortalities |
| Transport electrification | Electric buses and two-wheelers | Heavy diesel commercial shift | Comprehensive zero-emission | $580 billion | 7.4 million avoided mortalities |
| Agricultural stubble burning | Happy Seeder mechanization | Bio-pelletizing logistics hubs | Full biomass circular economy | $45 billion | 3.8 million avoided mortalities |
| Power sector transition | Retire unscrubbed coal units | Renewable power and storage baseline | Full grid decarbonization | $850 billion | 6.2 million avoided mortalities |
| Airshed sensor meshes | Satellite and reference-monitor grid | Hyperlocal sensors in 1,000 cities | Global predictive telemetry | $28 billion | High-leverage enabler |
""".strip()


def page_lines(text):
    lines = []
    for raw in text.splitlines():
        line = re.sub(r"\s+", " ", raw).strip()
        if not line:
            continue
        if "H HEURISTICS STRATEGIC MONOGRAPH" in line:
            continue
        if "H HEURISTICS RESEARCH REPORT" in line:
            continue
        if "H HEURISTICS · GLOBAL STRATEGIC" in line:
            continue
        if re.fullmatch(r"Page \d+ of \d+", line):
            continue
        lines.append(line)
    return lines


def is_structural(line):
    if re.match(r"^Chapter \d+\b", line):
        return True
    if line.startswith("Exhibit ") or line.startswith("Table "):
        return True
    if line.startswith("KEY TAKEAWAY"):
        return True
    if line.startswith("Data Source:"):
        return True
    if line.startswith("Scholarly Apparatus"):
        return True
    if line.startswith("Analytical Structure"):
        return True
    return False


def join_paragraphs(lines):
    paragraphs = []
    buf = []

    def flush():
        if buf:
            paragraphs.append(" ".join(buf).strip())
            buf.clear()

    for line in lines:
        if re.match(r"^\[\d+\]", line):
            flush()
            buf.append(line)
            continue
        if is_structural(line):
            flush()
            paragraphs.append(line)
            continue
        if not buf:
            buf.append(line)
            continue
        prev = buf[-1]
        if prev.endswith("-") and line[:1].islower():
            buf[-1] = prev + line
            continue
        if len(prev) >= 88:
            buf.append(line)
            continue
        flush()
        buf.append(line)
    flush()
    return paragraphs


DANGLING = (" and", " or", " the", " a", " an", " of", " as", " to", " for", ",", ":")


def looks_like_heading(text):
    if len(text) < 24 or len(text) > 120 or "." in text:
        return False
    words = text.split()
    if len(words) < 4:
        return False
    allowed = {"and", "or", "of", "the", "to", "in", "a", "for", "vs.", "on"}
    for word in words:
        bare = word.strip("—–-")
        if not bare or bare.lower() in allowed:
            continue
        if not bare[0].isupper() and not bare[0].isdigit():
            return False
    return True


def absorb_wrapped_heading(paragraphs, i):
    title = paragraphs[i]
    i += 1
    while i < len(paragraphs):
        nxt = paragraphs[i]
        if re.match(r"^(Chapter \d+|Exhibit |Table |KEY |Scholarly |Data Source:|\[)", nxt):
            break
        incomplete = len(title) < 56 or title.rstrip().endswith(DANGLING)
        if not incomplete:
            break
        if ". " in nxt or (len(nxt) > 90 and nxt.endswith(".")):
            break
        title = f"{title} {nxt}"
        i += 1
    return re.sub(r"\s+", " ", title).strip(), i


def absorb_subtitle(paragraphs, i):
    if i >= len(paragraphs):
        return None, i
    nxt = paragraphs[i]
    if re.match(r"^(Chapter \d+|Exhibit |Table |KEY |Scholarly |\[)", nxt):
        return None, i
    if ". " in nxt or nxt.endswith("."):
        return None, i
    if len(nxt) > 180:
        return None, i
    subtitle = nxt
    i += 1
    while i < len(paragraphs):
        more = paragraphs[i]
        if len(more.split()) > 3 or "." in more:
            break
        if re.match(r"^(Chapter |Exhibit |Table |KEY |\[)", more):
            break
        subtitle = f"{subtitle} {more}"
        i += 1
    return subtitle.strip(), i


def to_markdown(paragraphs):
    out = []
    i = 0
    while i < len(paragraphs):
        p = paragraphs[i]

        if p.startswith("Table 6"):
            out.append(TABLE_6)
            out.append("")
            i += 1
            while i < len(paragraphs) and not paragraphs[i].startswith("Financing this"):
                i += 1
            continue

        if p.startswith("Analytical Structure") or p.startswith("Systematic analytical") or p.startswith("Sec. Analytical"):
            i += 1
            continue

        if re.match(r"^Chapter \d+\b", p) or p.startswith("Scholarly Apparatus"):
            title, i = absorb_wrapped_heading(paragraphs, i)
            out.append(f"# {title}")
            out.append("")
            subtitle, i = absorb_subtitle(paragraphs, i)
            if subtitle:
                out.append(f"## {subtitle}")
                out.append("")
            continue

        if p.startswith("KEY TAKEAWAY"):
            out.append("### Key takeaway")
            out.append("")
            i += 1
            if i < len(paragraphs):
                insight = re.sub(r"^[▪•\-\s]*Strategic Insight:\s*", "", paragraphs[i])
                out.append(f"> {insight}")
                out.append("")
                i += 1
            continue

        if p.startswith("Exhibit ") or p.startswith("Table "):
            chunk = p
            i += 1
            while i < len(paragraphs) and not chunk.endswith("."):
                nxt = paragraphs[i]
                if nxt.startswith("Data Source:") or re.match(r"^(Chapter |Exhibit |Table |KEY |Scholarly |\[)", nxt):
                    break
                if len(nxt) > 240:
                    break
                chunk = f"{chunk} {nxt}"
                i += 1
            label, _, rest = chunk.partition(":")
            body = rest.strip() or chunk
            source = ""
            if i < len(paragraphs) and paragraphs[i].startswith("Data Source:"):
                source = paragraphs[i].replace("Data Source:", "").strip()
                i += 1
            out.append(f"> **{label.strip()}.** {body}")
            if source:
                out.append(">")
                out.append(f"> Source: {source}")
            out.append("")
            if label.strip().startswith("Table") and not label.strip().startswith("Table 6"):
                out.append("The typeset matrix is in the source PDF.")
                out.append("")
                while i < len(paragraphs):
                    nxt = paragraphs[i]
                    if len(nxt) > 220 and nxt.endswith("."):
                        break
                    if re.match(r"^(Chapter |KEY |Scholarly |Exhibit |Table )", nxt):
                        break
                    i += 1
            continue

        if p.startswith("Data Source:"):
            i += 1
            continue

        if re.match(r"^\[\d+\]", p):
            cite = p
            i += 1
            while i < len(paragraphs):
                nxt = paragraphs[i]
                if re.match(r"^(\[\d+\]|Chapter |Scholarly |KEY )", nxt):
                    break
                cite = f"{cite} {nxt}"
                i += 1
            out.append(f"- {re.sub(r'\\s+', ' ', cite)}")
            out.append("")
            continue

        if looks_like_heading(p):
            title = p
            i += 1
            while i < len(paragraphs):
                more = paragraphs[i]
                words = more.split()
                if len(words) > 3 or "." in more or not more[:1].isupper():
                    break
                if re.match(r"^(Chapter |Exhibit |Table |KEY |Scholarly |\[)", more):
                    break
                title = f"{title} {more}"
                i += 1
            out.append(f"## {title}")
            out.append("")
            continue

        out.append(p)
        out.append("")
        i += 1
    return "\n".join(out).strip() + "\n"


def main():
    if len(sys.argv) != 3:
        print("Usage: pdf_to_md.py <file.pdf> <body.md>", file=sys.stderr)
        sys.exit(2)
    reader = PdfReader(sys.argv[1])
    paragraphs = []
    # Page 1 is the cover. Page 2 is a typeset contents table that does not
    # survive text extraction; the site builds its own contents from headings.
    for page in reader.pages[2:]:
        paragraphs.extend(join_paragraphs(page_lines(page.extract_text() or "")))
    exploded = []
    for paragraph in paragraphs:
        parts = re.split(r"(?=\[\d+\])", paragraph)
        exploded.extend(part.strip() for part in parts if part.strip())
    markdown = to_markdown(exploded)
    with open(sys.argv[2], "w", encoding="utf-8") as fh:
        fh.write(markdown)
    print(f"wrote {sys.argv[2]} ({len(markdown.splitlines())} lines)")


if __name__ == "__main__":
    main()
