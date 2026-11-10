import { describe, expect, it } from "vitest";
import { decodeEntities, scan, toMarkdown } from "./html.ts";

const md = (html: string) => toMarkdown(html, new URL("https://site.example/courses/1/"), (u) => u.href);

describe("html (ported from html.rs)", () => {
  it("scripts, styles and forms are dropped", () => {
    expect(md("<head><title>T</title><style>p{}</style></head><p>Hi <script>alert('x</p>')</script>there</p><form><input name=a>Secret</form>")).toBe("Hi there");
  });

  it("structure becomes markdown", () => {
    const out = md(
      '<h2>Week&nbsp;1</h2><p>Read <strong>chapter 1 </strong>and <em>2</em>.</p><ul><li>One</li><li>Two<ul><li>Two a</li></ul></li></ul><ol><li>First</li><li>Second</li></ol><p>See <a href="pages/intro">the intro</a> or <a href="mailto:prof@x.edu">email</a>.</p><table><tr><th>Week</th><th>Topic</th></tr><tr><td>1</td><td>Limits | intro</td></tr></table><pre><code>let x = 1;\n  y</code></pre><blockquote><p>Quote</p></blockquote>',
    );
    expect(out).toBe(
      "## Week 1\n\nRead **chapter 1** and *2*.\n\n- One\n- Two\n  - Two a\n\n1. First\n2. Second\n\nSee [the intro](https://site.example/courses/1/pages/intro) or [email](mailto:prof@x.edu).\n\n| Week | Topic |\n| --- | --- |\n| 1 | Limits \\| intro |\n\n```\nlet x = 1;\n  y\n```\n\n> Quote",
    );
  });

  it("links are rewritten and javascript links dropped", () => {
    const out = toMarkdown(
      '<a href="/courses/1/files/9?wrap=1">Slides</a> <a href="javascript:evil()">x</a> <img src="/f/2" alt="Graph">',
      new URL("https://site.example/courses/1/pages/a"),
      (u) => (u.pathname === "/courses/1/files/9" ? "files/Slides.pdf" : u.href),
    );
    expect(out).toBe("[Slides](files/Slides.pdf) x ![Graph](https://site.example/f/2)");
  });

  it("scan finds links with their context and the title", () => {
    const s = scan(
      '<title> My  Page </title><p>Other paragraph.</p><p>Required textbook: <a href="https://openstax.org/details/books/calculus">Calculus Vol 1</a>, free online.</p>',
      new URL("https://site.example/"),
    );
    expect(s.title).toBe("My Page");
    expect(s.links.length).toBe(1);
    expect(s.links[0].text).toBe("Calculus Vol 1");
    expect(s.links[0].context).toBe("Required textbook: Calculus Vol 1, free online.");
    expect(s.text).toContain("Other paragraph.\nRequired textbook");
    // The title no longer leaks into the text.
    expect(s.text.startsWith("Other paragraph.")).toBe(true);
  });

  it("entities decode and odd input never throws", () => {
    expect(decodeEntities("a &amp; b &#x2014; &#8212; &bogus; &")).toBe("a & b — — &bogus; &");
    for (const junk of ["<", "<a href=", "<<p>>", "</>", "<a href='x", "&#xffffffff;", "<table><td>x", "<li>x<li>y", "<pre>"]) {
      md(junk);
      scan(junk, null);
    }
  });

  it("matches the Rust output on other shapes", () => {
    expect(md("<p>a<br>b</p><hr><table><tr><td>x</td><td>y<br>z</td></tr><tr><td>1</td></tr></table>")).toBe("a\nb\n\n---\n\n|  |  |\n| --- | --- |\n| x | y z |\n| 1 |  |");
    expect(md("<ol start=3><li>a<li>b</ol>")).toBe("3. a\n4. b");
    expect(md("<a href='x'></a>")).toBe("[https://site.example/courses/1/x](https://site.example/courses/1/x)");
    expect(md("<a>no href</a>")).toBe("no href");
    expect(md("<a href='#top'>frag</a>")).toBe("frag");
    expect(md("<p>x</p><math><mi>x</mi></math>z")).toBe("x\n\nz");
  });

  it("keeps what follows a nav, a form, an iframe or an unclosed head", () => {
    expect(md("<nav><ul><li><a href=x>Home</a></li></ul></nav><p>Body</p>")).toBe("Body");
    expect(md("<form><label>N</label><input></form><p>After</p>")).toBe("After");
    expect(md("<nav><nav>a</nav>b</nav><p>After</p>")).toBe("After");
    expect(md("<iframe src='https://y.example/v' title='Lecture'><p>fb</p></iframe><p>After</p>")).toBe("[Lecture](https://y.example/v)\n\nAfter");
    expect(md("<html><head><title>x</title><body><p>Text here</p>")).toBe("Text here");
    expect(scan("<html><head><title>x</title><body><p>Text <a href='https://a.example/b.pdf'>PDF</a></p>", null).links.length).toBe(1);
    expect(md("<ul><li>a<form><li>hidden</li></form></li><li>b</li></ul>")).toBe("- a\n- b");
  });
});
