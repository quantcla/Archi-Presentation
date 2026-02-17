const fs = require('fs');
const path = require('path');

console.log("--- STARTING WASM FIX ---");

// 1. Define paths
const sourceDir = path.join(__dirname, 'node_modules', 'web-ifc');
const targetDir = path.join(__dirname, 'public', 'wasm');

// 2. Create public/wasm folder if missing
if (!fs.existsSync(targetDir)) {
    console.log("Creating folder: public/wasm");
    fs.mkdirSync(targetDir, { recursive: true });
}

// 3. Files to copy
const filesToCopy = ['web-ifc.wasm', 'web-ifc-mt.wasm'];

filesToCopy.forEach(file => {
    const srcPath = path.join(sourceDir, file);
    const destPath = path.join(targetDir, file);

    if (fs.existsSync(srcPath)) {
        fs.copyFileSync(srcPath, destPath);
        console.log(`✅ SUCCESS: Copied ${file} to public/wasm/`);
    } else {
        console.error(`❌ ERROR: Could not find ${file} in node_modules.`);
        console.error(`   Run 'npm install web-ifc' and try again.`);
    }
});

console.log("--- FIX COMPLETE ---");