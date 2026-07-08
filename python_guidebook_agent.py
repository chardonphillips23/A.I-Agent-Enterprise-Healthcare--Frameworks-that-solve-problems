"""
Python Fundamentals Guidebook Agent
Generates a comprehensive Python guidebook using the Claude API.
"""

import anthropic
import os

TOPICS = [
    "Variables and Data Types",
    "Operators and Expressions",
    "Control Flow (if/elif/else, loops)",
    "Functions and Scope",
    "Data Structures (lists, tuples, dicts, sets)",
    "String Manipulation",
    "File I/O",
    "Error Handling and Exceptions",
    "Object-Oriented Programming",
    "Modules and Packages",
    "List Comprehensions and Generators",
    "Built-in Functions and the Standard Library",
]

SYSTEM_PROMPT = """You are an expert Python educator writing a comprehensive guidebook for beginners and intermediate learners.

For each topic you write about:
- Use clear, friendly language accessible to newcomers
- Provide concise explanations of core concepts
- Include practical, runnable code examples with comments
- Highlight common mistakes and best practices
- Use headers and structure for readability

Format your output in clean Markdown."""

def generate_topic_section(client: anthropic.Anthropic, topic: str) -> str:
    """Generate a guidebook section for a single topic using streaming."""
    print(f"  Generating: {topic}...")

    full_text = ""
    with client.messages.stream(
        model="claude-opus-4-7",
        max_tokens=2048,
        thinking={"type": "adaptive"},
        system=SYSTEM_PROMPT,
        messages=[
            {
                "role": "user",
                "content": (
                    f"Write a detailed guidebook section on **{topic}** in Python. "
                    "Include:\n"
                    "- A brief conceptual overview\n"
                    "- At least 2–3 code examples with explanations\n"
                    "- Key tips and common pitfalls\n"
                    "Format in Markdown with clear headings."
                ),
            }
        ],
    ) as stream:
        for text in stream.text_stream:
            full_text += text
            print(text, end="", flush=True)

    print()  # newline after streamed content
    return full_text


def generate_introduction(client: anthropic.Anthropic) -> str:
    """Generate the guidebook introduction."""
    print("  Generating: Introduction...")

    full_text = ""
    with client.messages.stream(
        model="claude-opus-4-7",
        max_tokens=1024,
        system=SYSTEM_PROMPT,
        messages=[
            {
                "role": "user",
                "content": (
                    "Write a welcoming introduction for a Python fundamentals guidebook. "
                    "Cover: what Python is, why it's popular, who this guide is for, "
                    "how to install Python, and how to use this guidebook. "
                    "Keep it encouraging and practical. Format in Markdown."
                ),
            }
        ],
    ) as stream:
        for text in stream.text_stream:
            full_text += text
            print(text, end="", flush=True)

    print()
    return full_text


def generate_conclusion(client: anthropic.Anthropic) -> str:
    """Generate the guidebook conclusion and next steps."""
    print("  Generating: Conclusion & Next Steps...")

    full_text = ""
    with client.messages.stream(
        model="claude-opus-4-7",
        max_tokens=512,
        system=SYSTEM_PROMPT,
        messages=[
            {
                "role": "user",
                "content": (
                    "Write a brief, motivating conclusion for a Python fundamentals guidebook. "
                    "Include suggested next steps, recommended learning resources, "
                    "and encouragement for the reader. Format in Markdown."
                ),
            }
        ],
    ) as stream:
        for text in stream.text_stream:
            full_text += text
            print(text, end="", flush=True)

    print()
    return full_text


def build_table_of_contents() -> str:
    """Build a Markdown table of contents."""
    toc = "## Table of Contents\n\n"
    toc += "1. [Introduction](#introduction)\n"
    for i, topic in enumerate(TOPICS, start=2):
        anchor = topic.lower().replace(" ", "-").replace("(", "").replace(")", "").replace("/", "").replace(",", "")
        toc += f"{i}. [{topic}](#{anchor})\n"
    toc += f"{len(TOPICS) + 2}. [Conclusion & Next Steps](#conclusion--next-steps)\n"
    return toc


def main():
    api_key = os.environ.get("ANTHROPIC_API_KEY")
    if not api_key:
        # Try common config locations used by Claude Code
        config_paths = [
            os.path.expanduser("~/.anthropic/api_key"),
            os.path.expanduser("~/.config/anthropic/api_key"),
        ]
        for path in config_paths:
            if os.path.exists(path):
                with open(path) as f:
                    api_key = f.read().strip()
                break
    if not api_key:
        raise EnvironmentError(
            "ANTHROPIC_API_KEY not set. Export it or store it in ~/.anthropic/api_key"
        )

    client = anthropic.Anthropic(api_key=api_key)

    print("=" * 60)
    print("  Python Fundamentals Guidebook Generator")
    print("=" * 60)

    sections = []

    # Header
    sections.append("# Python Fundamentals: A Complete Guidebook\n")
    sections.append(build_table_of_contents())

    # Introduction
    print("\n[1/14] Introduction")
    intro = generate_introduction(client)
    sections.append(f"\n---\n\n## Introduction\n\n{intro}")

    # Topic sections
    for i, topic in enumerate(TOPICS, start=2):
        print(f"\n[{i}/14] {topic}")
        content = generate_topic_section(client, topic)
        sections.append(f"\n---\n\n## {topic}\n\n{content}")

    # Conclusion
    print(f"\n[14/14] Conclusion")
    conclusion = generate_conclusion(client)
    sections.append(f"\n---\n\n## Conclusion & Next Steps\n\n{conclusion}")

    # Write guidebook to file
    output_path = os.path.join(os.path.dirname(__file__), "Python_Fundamentals_Guidebook.md")
    guidebook = "\n".join(sections)

    with open(output_path, "w", encoding="utf-8") as f:
        f.write(guidebook)

    print("\n" + "=" * 60)
    print(f"  Guidebook saved to: {output_path}")
    print(f"  Total sections: {len(TOPICS) + 2} (intro + {len(TOPICS)} topics + conclusion)")
    print("=" * 60)


if __name__ == "__main__":
    main()
