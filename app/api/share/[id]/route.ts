import { NextRequest, NextResponse } from 'next/server';
import { storageGetJson } from '../../../lib/storage';

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const data = await storageGetJson(`presentations/${id}/presentation.json`);
    if (!data) {
      return NextResponse.json({ error: 'Presentation not found' }, { status: 404 });
    }
    return NextResponse.json(data);
  } catch {
    return NextResponse.json({ error: 'Presentation not found' }, { status: 404 });
  }
}
