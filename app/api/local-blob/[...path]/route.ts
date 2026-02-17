import { NextRequest, NextResponse } from 'next/server';
import { readFile } from 'fs/promises';
import { join } from 'path';

// Serves files from local data/ directory during development
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ path: string[] }> }
) {
  try {
    const { path } = await params;
    const filePath = path.join('/');

    // Sanitize — no path traversal
    if (filePath.includes('..')) {
      return NextResponse.json({ error: 'Invalid path' }, { status: 400 });
    }

    const fullPath = join(process.cwd(), 'data', filePath);
    const buffer = await readFile(fullPath);

    let contentType = 'application/octet-stream';
    if (filePath.endsWith('.glb')) contentType = 'model/gltf-binary';
    else if (filePath.endsWith('.pdf')) contentType = 'application/pdf';
    else if (filePath.endsWith('.json')) contentType = 'application/json';

    return new NextResponse(buffer, {
      headers: { 'Content-Type': contentType },
    });
  } catch {
    return NextResponse.json({ error: 'File not found' }, { status: 404 });
  }
}
