import type { APIRoute } from 'astro';
import { sitemapRoutes } from '../data/nav';
import { absoluteUrl } from '../data/site';

export const GET: APIRoute = () => {
  const urls = sitemapRoutes().map((r) => `  <url><loc>${absoluteUrl(r.pattern === '/' ? '' : r.pattern) || absoluteUrl('')}</loc></url>`);
  const body = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join('\n')}\n</urlset>\n`;
  return new Response(body, { headers: { 'Content-Type': 'application/xml; charset=utf-8' } });
};
