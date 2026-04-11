import { NextRequest, NextResponse } from 'next/server';

export function middleware(req: NextRequest) {
  const host = req.headers.get('host') ?? '';

  // Redirect www → non-www
  if (host.startsWith('www.')) {
    const url = req.nextUrl.clone();
    url.host = host.replace(/^www\./, '');
    return NextResponse.redirect(url, 301);
  }

  return NextResponse.next();
}
