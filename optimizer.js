let loadingFFmpeg = false;

const drop = document.getElementById("drop");
const status = document.getElementById("status");
const bar = document.getElementById("bar");
const downloadBtn = document.getElementById("download");
const cancelBtn = document.getElementById("cancel");
const statsDiv = document.getElementById("stats");

let cancelled = false;
cancelBtn.onclick = () => { cancelled = true; status.textContent = "Cancelled by user"; };

drop.onclick = () => {
  let input = document.getElementById("fileInput");
  if (!input) {
    drop.innerHTML += '<input type="file" id="fileInput" accept=".sb3" style="display:none">';
    input = document.getElementById("fileInput");
  }
  input.click();
};

drop.ondragover = e => { e.preventDefault(); drop.classList.add("drag"); };
drop.ondragleave = () => drop.classList.remove("drag");
drop.ondrop = e => {
  e.preventDefault(); drop.classList.remove("drag");
  const file = e.dataTransfer.files[0];
  if (file) processFile(file).catch(err => status.textContent = `Error: ${err.message}`);
};

// Support click-to-select
document.addEventListener("change", e => {
  if (e.target.id === "fileInput" && e.target.files[0]) processFile(e.target.files[0]).catch(err => status.textContent = `Error: ${err.message}`);
});

async function processFile(file) {
  if (!file.name.toLowerCase().endsWith(".sb3")) {
    status.textContent = "Please select a .sb3 file";
    return;
  }
  
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
  const projectEntry = zip.file("project.json");
  if (projectEntry) {
    projectJson = JSON.parse(await projectEntry.async("text"));
  } else {
    status.textContent = "No project.json found!";
    return;
  }

  const entries = Object.keys(zip.files).filter(path => path !== "project.json");
  let processed = 0;
  const total = entries.length + 1; // +1 for json

  // Preload ffmpeg if needed (global FFmpeg from script tag)
  const ffmpeg = FFmpeg.createFFmpeg({ log: true });
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

    let newName, blob, newExt = ext;
    try {
      if (ext === "svg") {
        const text = await entry.async("text");
        const optimized = SVGO.optimize(text, { multipass: true, path });
        blob = new Blob([optimized.data], { type: "image/svg+xml" });
      } else if (["png","jpg","jpeg"].includes(ext)) {
        const imgBlob = await entry.async("blob");
        const bitmap = await createImageBitmap(imgBlob);
        const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
        const ctx = canvas.getContext("2d");
        ctx.drawImage(bitmap, 0, 0);
        blob = await canvas.convertToBlob({ type: "image/webp", quality: 0.80 });
        newExt = "webp";
      } else if (["wav","mp3"].includes(ext)) {
        const arrayBuffer = await entry.async("arraybuffer");
        ffmpeg.FS("writeFile", path, new Uint8Array(arrayBuffer));

        // Capture duration from logs
        let logs = '';
        const originalLogger = ffmpeg.setLogger;
        ffmpeg.setLogger(({ message }) => {
          logs += message + '\n';
        });

        await ffmpeg.run('-i', path, '-f', 'null', '/dev/null');

        ffmpeg.setLogger(originalLogger); // Reset

        const durationMatch = logs.match(/Duration: (\d+):(\d+):([\d.]+)/);
        const duration = durationMatch ? parseFloat(durationMatch[1]) * 3600 + parseFloat(durationMatch[2]) * 60 + parseFloat(durationMatch[3]) : 999;

        const outExt = (duration < 5) ? "wav" : "mp3";
        const outName = "out." + outExt;

        const args = ["-i", path, "-ac", "1", "-ar", "16000"];
        if (outExt === "wav") {
          args.push("-f", "wav", outName);
        } else {
          args.push("-c:a", "libmp3lame", "-q:a", "8", outName);
        }
        await ffmpeg.run(...args);

        const data = ffmpeg.FS("readFile", outName);
        blob = new Blob([data.buffer], { type: "audio/" + outExt });
        newExt = outExt;

        ffmpeg.FS("unlink", path);
        ffmpeg.FS("unlink", outName);
      } else {
        // Copy unchanged
        blob = await entry.async("blob");
      }

      const newMd5 = await getMd5(blob);
      newName = newMd5 + "." + newExt;
      assetMap.set(path, newName);
      newZip.file(newName, blob);
    } catch (err) {
      console.error(`Error optimizing ${path}:`, err);
      // Fallback to original if error
      newZip.file(path, await entry.async("blob"));
    }

    processed++;
    bar.style.width = `${15 + 80 * (processed / total)}%`;
  }

  if (cancelled) return cleanup();

  // Fix project.json references
  function updateAssets(obj) {
    ["costumes","sounds"].forEach(type => {
      if (obj[type]) {
        obj[type].forEach(asset => {
          const old = asset.md5ext;
          if (assetMap.has(old)) {
            const parts = assetMap.get(old).split(".");
            asset.assetId = parts[0];
            asset.dataFormat = parts[1];
            asset.md5ext = assetMap.get(old);
          }
        });
      }
    });
  }

  projectJson.targets.forEach(updateAssets);

  // Minify + write project.json
  newZip.file("project.json", JSON.stringify(projectJson, null, 0));

  bar.style.width = "95%";
  status.textContent = "Compressing final .sb3...";

  const finalBlob = await newZip.generateAsync({ type: "blob", compression: "DEFLATE" });

  const saved = originalSize - finalBlob.size;
  const percent = (saved / originalSize * 100).toFixed(1);

  statsDiv.style.display = "block";
  statsDiv.innerHTML = `
    Original: ${(originalSize / 1024 / 1024).toFixed(2)} MB<br>
    Optimized: ${(finalBlob.size / 1024 / 1024).toFixed(2)} MB<br>
    <b>Saved ${saved > 1024*1024 ? (saved/1024/1024).toFixed(1)+" MB" : (saved/1024).toFixed(0)+" KB"} (${percent}% reduction)</b>
  `;

  const url = URL.createObjectURL(finalBlob);
  downloadBtn.style.display = "inline-block";
  downloadBtn.onclick = () => {
    const a = document.createElement("a");
    a.href = url;
    a.download = file.name.replace(/\.sb3$/i, "_TURBO.sb3");
    a.click();
  };

  status.textContent = "Complete! Click download";
  cancelBtn.style.display = "none";
  bar.style.width = "100%";
}

function cleanup() {
  status.textContent = "Cancelled — nothing saved";
  bar.style.width = "0%";
  downloadBtn.style.display = "none";
  cancelBtn.style.display = "none";
  statsDiv.style.display = "none";
}

// MD5 hash
async function getMd5(blob) {
  const buffer = await blob.arrayBuffer();
  return md5(new Uint8Array(buffer));
}
