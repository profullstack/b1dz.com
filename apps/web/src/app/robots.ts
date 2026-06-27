import type { MetadataRoute } from 'next';

const BASE_URL = 'https://b1dz.com';

// Explicit allow rules for the major AI / answer-engine crawlers so they
// don't fall back to defaults, plus a sitemap pointer for discovery.
const AI_BOTS = [
  'GPTBot',
  'OAI-SearchBot',
  'ChatGPT-User',
  'ClaudeBot',
  'Claude-Web',
  'PerplexityBot',
  'Google-Extended',
  'Applebot-Extended',
  'CCBot',
  'Bytespider',
];

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: '*',
        allow: '/',
        // Authenticated app surfaces — keep out of the index.
        disallow: ['/api/', '/dashboard', '/console', '/settings'],
      },
      ...AI_BOTS.map((userAgent) => ({ userAgent, allow: '/' })),
    ],
    sitemap: `${BASE_URL}/sitemap.xml`,
    host: BASE_URL,
  };
}
