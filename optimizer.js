import { createFFmpeg, fetchFile } from "https://cdn.jsdelivr.net/npm/@ffmpeg/ffmpeg@0.12.10/dist/umd/ffmpeg.min.js";

const ffmpeg = createFFmpeg({ log: true }); // Enable logging for duration grab
let loadingFFmpeg = false;

const drop = document.getElementById("drop");
const status = document.getElementById("status");
const bar = document.getElementById("bar");
const downloadBtn = document.getElementById("download");
const cancelBtn = document.getElementById("cancel");
const statsDiv = document.getElementById("stats");

let cancelled = false;
cancelBtn.onclick = () => { cancelled = true; status.textContent = "Cancelled by user"; };

drop.onclick = () => document.getElementById("fileInput")?.click() || (drop.innerHTML = `<input type="file" id="fileInput" accept=".sb3" style="display:none">`);
document.body.onclick = e => { if (e.target === drop) document.getElementById("fileInput")?.click(); };

drop.ondragover = e => { e.preventDefault(); drop.classList.add("drag"); };
drop.ondragleave = drop.ondrop = e => { e.preventDefault(); drop.classList.remove("drag"); };

drop.ondrop = e => {
  e.preventDefault(); drop.classList.remove("drag");
  const file = e.dataTransfer.files[0];
  if (file) processFile(file).catch(err => status.textContent = `Error: ${err.message}`);
};

// Also support click-to-select
document.body.addEventListener("change", e => {
  if (e.target.id === "fileInput" && e.target.files[0]) processFile(e.target.files[0]).catch(err => status.textContent = `Error: ${err.message}`);
});

async function processFile(file) {
  if (!file.name.toLowerCase().endsWith(".sb3")) return status.textContent = "Please select a .sb3 file";
  
  cancelled = false;
  cancelBtn.style.display = "inline-block";
  downloadBtn.style.display = "none";
  statsDiv.style.display = "none";
  status.textContent = "Loading...";
  bar.style.width = "5%";

  const zipData = await file.arrayBuffer();
  const originalSize = file.size;

  const zip = await JSZip.loadAsync(zipData);
  const newZip = new JSZip();
  let projectJson = null;

  // Load project.json first
  if (zip.file("project.json")) {
    projectJson = JSON.parse(await zip.file("project.json").async("text"));
  } else {
    return status.textContent = "No project.json found!";
  }

  const entries = Object.keys(zip.files);
  let processed = 0;
  const total = entries.length;

  // Preload ffmpeg if needed
  if (!ffmpeg.isLoaded() && !loadingFFmpeg) {
    loadingFFmpeg = true;
    status.textContent = "Downloading audio engine... (first time only)";
    await ffmpeg.load();
    loadingFFmpeg = false;
  }
  if (cancelled) return cleanup();

  status.textContent = "Optimizing assets...";
  bar.style.width = "15%";

  const assetMap = new Map(); // old md5ext → new md5ext

  for (const path of entries) {
    if (cancelled) break;
    const entry = zip.file(path);
    if (!entry) continue;

    const ext = path.split('.').pop().toLowerCase();

    if (path === "project.json") {
      // We'll write minified version at the end
      continue;
    }
    else if (ext === "svg") {
      const text = await entry.async("text");
      const optimized = SVGO.optimize(text, { multipass: true, path });
      const blob = new Blob([optimized.data], { type: "image/svg+xml" });
      const newMd5 = await getMd5(blob);
      const newName = newMd5 + ".svg";
      assetMap.set(path, newName);
      newZip.file(newName, blob);
    }
    else if (["png","jpg","jpeg"].includes(ext)) {
      const blob = await entry.async("blob");
      const bitmap = await createImageBitmap(blob);
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const ctx = canvas.getContext("2d");
      ctx.drawImage(bitmap, 0, 0);
      const webpBlob = await canvas.convertToBlob({ type: "image/webp", quality: 0.80 });
      const newMd5 = await getMd5(webpBlob);
      const newName = newMd5 + ".webp";
      assetMap.set(path, newName);
      newZip.file(newName, webpBlob);
    }
    else if (["wav","mp3"].includes(ext)) {
      const arrayBuffer = await entry.async("arraybuffer");
      const uint8 = new Uint8Array(arrayBuffer);
      ffmpeg.FS("writeFile", path, uint8);

      // Capture logs for duration
      let logs = '';
      const oldLogger = ffmpeg.setLogger;
      ffmpeg.setLogger(({ message }) => { logs += message + '\n'; });

      await ffmpeg.run('-i', path, '-f', 'null', '-map', '0:a', '/dev/null');

      ffmpeg.setLogger(oldLogger); // Reset

      const durationMatch = logs.match(/Duration: (\d+):(\d+):([\d.]+)/);
      const duration = durationMatch ? parseFloat(durationMatch[1]) * 3600 + parseFloat(durationMatch[2]) * 60 + parseFloat(durationMatch[3]) : 999;

      const outExt = (duration < 5) ? "wav" : "mp3";
      const outName = "out." + outExt;

      if (outExt === "wav") {
        await ffmpeg.run("-i", path, "-ac", "1", "-ar", "16000", "-f", "wav", outName);
      } else {
        await ffmpeg.run("-i", path, "-ac", "1", "-ar", "16000", "-c:a", "libmp3lame", "-q:a", "8", outName);
      }

      const data = ffmpeg.FS("readFile", outName);
      const blob = new Blob([data.buffer], { type: "audio/" + outExt });
      const newMd5 = await getMd5(blob);
      const newName = newMd5 + "." + outExt;
      assetMap.set(path, newName);
      newZip.file(newName, blob);

      ffmpeg.FS("unlink", path);
      ffmpeg.FS("unlink", outName);
    }
    else {
      // Copy unchanged
      newZip.file(path, await entry.async("blob"));
    }

    processed++;
    bar.style.width = `${15 + 80 * (processed / total)}%`;
  }

  if (cancelled) return cleanup();

  // Fix project.json references
  function updateAssets(obj) {
    ["costumes","sounds"].forEach(type => {
      if (!obj[type]) return;
      obj[type].forEach(asset => {
        const old = asset.md5ext;
        if (assetMap.has(old)) {
          const parts = assetMap.get(old).split(".");
          asset.assetId = parts[0];
          asset.dataFormat = parts[1];
          asset.md5ext = assetMap.get(old);
        }
      });
    });
  }

  projectJson.targets.forEach(target => updateAssets(target));
  if (projectJson.monitors) ; // skip
  if (projectJson.extensions) ; // skip

  // Minify + write project.json
  newZip.file("project.json", JSON.stringify(projectJson));

  bar.style.width = "100%";
  status.textContent = "Compressing final .sb3...";

  const finalBlob = await newZip.generateAsync({ type: "blob", compression: "DEFLATE" }, meta => {
    bar.style.width = `${95 + 5 * (meta.percent / 100)}%`;
  });

  const saved = originalSize - finalBlob.size;
  const percent = (saved / originalSize * 100).toFixed(1);

  statsDiv.style.display = "block";
  statsDiv.innerHTML = `
    Original: ${(originalSize/1024/1024).toFixed(2)} MB<br>
    Optimized: ${(finalBlob.size/1024/1024).toFixed(2)} MB<br>
    <b>Saved ${saved > 1024*1024 ? (saved/1024/1024).toFixed(1)+" MB" : (saved/1024).toFixed(0)+" KB"} (${percent}% reduction)</b>
  `;

  const url = URL.createObjectURL(finalBlob);
  downloadBtn.style.display = "inline-block";
  downloadBtn.onclick = () => {
    const a = document.createElement("a");
    a.href = url;
    a.download = file.name.replace(/\.sb3$/i, "") + "_TURBO.sb3";
    a.click();
  };

  status.textContent = "Complete! Click download";
  cancelBtn.style.display = "none";
}

function cleanup() {
  status.textContent = "Cancelled — nothing saved";
  bar.style.width = "0%";
  downloadBtn.style.display = "none";
  cancelBtn.style.display = "none";
  statsDiv.style.display = "none";
}

// MD5 hash (using blueimp-md5)
async function getMd5(blob) {
  const arrayBuffer = await blob.arrayBuffer();
  const uint8Array = new Uint8Array(arrayBuffer);
  const hashArray = md5(uint8Array); // blueimp-md5 returns hex string
  return hashArray;
}
