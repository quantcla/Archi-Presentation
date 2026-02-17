import { NextRequest, NextResponse } from 'next/server';
import { writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

export async function POST(req: NextRequest) {
  try {
    const formData = await req.formData();
    const file = formData.get('file') as File;
    const projectName = formData.get('name') as string || 'project';

    if (!file) {
      return NextResponse.json({ error: 'No file uploaded' }, { status: 400 });
    }

    // 1. Save SVG to a temporary location
    const buffer = Buffer.from(await file.arrayBuffer());
    const tempDir = join(process.cwd(), 'python', 'temp');
    await mkdir(tempDir, { recursive: true });
    
    const tempSvgPath = join(tempDir, `input_${Date.now()}.svg`);
    await writeFile(tempSvgPath, buffer);

    // 2. Call Python Script
    const pythonScript = join(process.cwd(), 'python', 'bridge.py');
    // Note: Ensure 'python' is in your system PATH, or use full path like 'C:\\Python39\\python.exe'
    const command = `python "${pythonScript}" --svg "${tempSvgPath}" --name "${projectName}"`;

    const { stdout, stderr } = await execAsync(command);

    // 3. Parse Result
    // Python script prints JSON to stdout
    try {
        const result = JSON.parse(stdout.trim());
        return NextResponse.json(result);
    } catch (e) {
        console.error("Python Output Error:", stdout);
        return NextResponse.json({ 
            success: false, 
            error: "Failed to parse Python response", 
            details: stdout,
            stderr: stderr 
        });
    }

  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}