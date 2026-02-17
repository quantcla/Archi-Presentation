import { NextRequest, NextResponse } from 'next/server';
import { handleUpload, type HandleUploadBody } from '@vercel/blob/client';

// This endpoint generates client upload tokens for direct browser-to-blob uploads
// Used for large files (360° images, large PDFs) that exceed the 4.5MB serverless limit
export async function POST(req: NextRequest) {
  const body = (await req.json()) as HandleUploadBody;

  try {
    const jsonResponse = await handleUpload({
      body,
      request: req,
      onBeforeGenerateToken: async (pathname) => {
        // Validate the upload path — must be under presentations/
        if (!pathname.startsWith('presentations/')) {
          throw new Error('Invalid upload path');
        }
        return {
          allowedContentTypes: ['image/jpeg', 'image/png', 'image/webp', 'application/pdf', 'model/gltf-binary', 'application/octet-stream'],
          maximumSizeInBytes: 50 * 1024 * 1024, // 50MB max
        };
      },
      onUploadCompleted: async () => {
        // Nothing needed after upload
      },
    });
    return NextResponse.json(jsonResponse);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
