import { JsonStorage } from '@b1dz/storage-json';
import { COLLECTIONS, score, type Opportunity } from '@b1dz/core';
import path from 'node:path';

export async function GET() {
  const storage = new JsonStorage(path.join(process.cwd(), '..', '..', 'data'));
  const all = await storage.list<Opportunity>(COLLECTIONS.opportunities);
  const sorted = all.sort((a, b) => score(b) - score(a));
  return Response.json({ opportunities: sorted });
}
