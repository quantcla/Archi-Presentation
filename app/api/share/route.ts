import { NextRequest, NextResponse } from 'next/server';
import { storagePut } from '../../lib/storage';

export async function POST(req: NextRequest) {
  try {
    const formData = await req.formData();
    const metadataStr = formData.get('metadata') as string;
    if (!metadataStr) {
      return NextResponse.json({ error: 'No metadata provided' }, { status: 400 });
    }

    const metadata = JSON.parse(metadataStr);
    const id = metadata.id;
    if (!id) {
      return NextResponse.json({ error: 'No presentation ID' }, { status: 400 });
    }

    // Upload each model GLB
    for (const model of metadata.models || []) {
      const glbFile = formData.get(`model_${model.id}`) as File | null;
      if (glbFile) {
        const result = await storagePut(`presentations/${id}/${model.glbFilename}`, glbFile);
        model.glbUrl = result.url;
      }
    }

    // Upload PDF if provided
    const pdfFile = formData.get('pdf') as File | null;
    if (pdfFile) {
      const result = await storagePut(`presentations/${id}/attachment.pdf`, pdfFile);
      metadata.pdfFilename = 'attachment.pdf';
      metadata.pdfUrl = result.url;
    }

    // Upload metadata JSON
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
