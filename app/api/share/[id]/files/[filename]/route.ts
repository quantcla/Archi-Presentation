import { NextRequest, NextResponse } from 'next/server';
import { storageGetFileUrl } from '../../../../../lib/storage';

// Redirects to the actual file URL (blob URL or local file server)
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; filename: string }> }
) {
  try {
    const { id, filename } = await params;

    // Sanitize
    const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, '');
    if (safeName !== filename || filename.includes('..')) {
      return NextResponse.json({ error: 'Invalid filename' }, { status: 400 });
    }

    const url = await storageGetFileUrl(`presentations/${id}/${safeName}`);
    if (!url) {
      return NextResponse.json({ error: 'File not found' }, { status: 404 });
    }

    return NextResponse.redirect(url);
  } catch {
    return NextResponse.json({ error: 'File not found' }, { status: 404 });
  }
}
