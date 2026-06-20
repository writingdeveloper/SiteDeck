import { describe, it, expect } from 'vitest';
import { parseOnPage } from './onpage';

const FULL = `<!doctype html><html><head>
  <title>Soursea — AI tools</title>
  <meta name="description" content="Find the best AI tools." />
  <link rel="canonical" href="https://soursea.io/" />
  <meta property="og:title" content="Soursea" />
  <meta property="og:image" content="https://soursea.io/og.png" />
  <script type="application/ld+json">{"@type":"WebSite"}</script>
</head><body>hi</body></html>`;

describe('parseOnPage', () => {
  it('detects all signals in a fully-marked-up page', () => {
    expect(parseOnPage(FULL)).toEqual({
      title: true,
      description: true,
      canonical: true,
      openGraph: true,
      structuredData: true,
    });
  });

  it('reports false for an empty document', () => {
    expect(parseOnPage('<html></html>')).toEqual({
      title: false,
      description: false,
      canonical: false,
      openGraph: false,
      structuredData: false,
    });
  });

  it('treats an empty or whitespace title as missing', () => {
    expect(parseOnPage('<title>   </title>').title).toBe(false);
    expect(parseOnPage('<title>Real</title>').title).toBe(true);
  });

  it('requires a non-empty description content', () => {
    expect(parseOnPage('<meta name="description" content="">').description).toBe(false);
    expect(parseOnPage('<meta name="description" content="x">').description).toBe(true);
  });

  it('is case-insensitive and tolerant of attribute order', () => {
    const html = '<META CONTENT="d" NAME="Description"><LINK HREF="/c" REL="Canonical">';
    const r = parseOnPage(html);
    expect(r.description).toBe(true);
    expect(r.canonical).toBe(true);
  });

  it('detects Open Graph via any og: property', () => {
    expect(parseOnPage('<meta property="og:type" content="website">').openGraph).toBe(true);
    expect(parseOnPage('<meta name="twitter:card" content="x">').openGraph).toBe(false);
  });

  it('detects JSON-LD structured data with either quote style', () => {
    expect(parseOnPage(`<script type='application/ld+json'>{}</script>`).structuredData).toBe(true);
    expect(parseOnPage('<script type="text/javascript"></script>').structuredData).toBe(false);
  });
});
