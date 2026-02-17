import { NextRequest, NextResponse } from 'next/server';
import { storagePut } from '../../lib/storage';

export const maxDuration = 60;

// Upload a single file (called multiple times from client for each GLB/PDF)
// Body: FormData with 'file' + 'path' fields
// OR: FormData with 'metadata' for final metadata-only upload
export async function POST(req: NextRequest) {
  try {
    const formData = await req.formData();

    // Check if this is a file upload or metadata upload
    const action = formData.get('action') as string;

    if (action === 'upload-file') {
      // Single file upload (GLB or PDF)
      const file = formData.get('file') as File | null;
      const path = formData.get('path') as string;
      if (!file || !path) {
        return NextResponse.json({ error: 'Missing file or path' }, { status: 400 });
      }
      // Sanitize path
      if (path.includes('..')) {
        return NextResponse.json({ error: 'Invalid path' }, { status: 400 });
      }
      const result = await storagePut(path, file);
      return NextResponse.json({ success: true, url: result.url });
    }

    if (action === 'save-metadata') {
      // Final metadata save (small JSON, no binary)
      const metadataStr = formData.get('metadata') as string;
      if (!metadataStr) {
        return NextResponse.json({ error: 'No metadata provided' }, { status: 400 });
      }
      const metadata = JSON.parse(metadataStr);
      const id = metadata.id;
      if (!id) {
        return NextResponse.json({ error: 'No presentation ID' }, { status: 400 });
      }
      await storagePut(
        `presentations/${id}/presentation.json`,
        JSON.stringify(metadata, null, 2),
        { contentType: 'application/json' }
      );
      return NextResponse.json({ success: true, id, url: `/share/${id}` });
    }

    // Legacy: single-request upload (for local dev with small files)
    const metadataStr = formData.get('metadata') as string;
    if (!metadataStr) {
      return NextResponse.json({ error: 'No metadata or action provided' }, { status: 400 });
    }

    const metadata = JSON.parse(metadataStr);
    const id = metadata.id;
    if (!id) {
      return NextResponse.json({ error: 'No presentation ID' }, { status: 400 });
    }

    for (const model of metadata.models || []) {
      const glbFile = formData.get(`model_${model.id}`) as File | null;
      if (glbFile) {
        const result = await storagePut(`presentations/${id}/${model.glbFilename}`, glbFile);
        model.glbUrl = result.url;
      }
    }

    const pdfFile = formData.get('pdf') as File | null;
    if (pdfFile) {
      const result = await storagePut(`presentations/${id}/attachment.pdf`, pdfFile);
      metadata.pdfFilename = 'attachment.pdf';
      metadata.pdfUrl = result.url;
    }

    await storagePut(
      `presentations/${id}/presentation.json`,
      JSON.stringify(metadata, null, 2),
      { contentType: 'application/json' }
    );

    return NextResponse.json({ success: true, id, url: `/share/${id}` });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error('Share API error:', message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
