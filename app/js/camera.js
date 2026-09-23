// FluteBand AI — камера и подготовка изображения страницы.
// Камера доступна только в защищённом контексте: localhost или HTTPS (важно для телефона по Wi-Fi).
import { preprocessImageData, grayFromRgba, grayStats, pageBounds } from './image-prep.js';

export function cameraSupport() {
  const hasApi = typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia;
  const secure = typeof window !== 'undefined' ? window.isSecureContext !== false : true;
  return { hasApi, secure, ok: hasApi && secure };
}

export class CameraCapture {
  constructor(videoEl) {
    this.video = videoEl;
    this.stream = null;
  }

  get active() {
    return !!this.stream;
  }

  async start({ facingMode = 'environment', width = 1920, height = 1080 } = {}) {
    const support = cameraSupport();
    if (!support.hasApi) throw new Error('CAMERA_UNSUPPORTED');
    if (!support.secure) throw new Error('INSECURE_CONTEXT');
    this.stop();
    this.stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: facingMode }, width: { ideal: width }, height: { ideal: height } },
      audio: false,
    });
    this.video.srcObject = this.stream;
    this.video.setAttribute('playsinline', 'true');
    await this.video.play().catch(() => {});
    return this.stream;
  }

  stop() {
    if (this.stream) {
      for (const track of this.stream.getTracks()) track.stop();
      this.stream = null;
    }
    if (this.video) this.video.srcObject = null;
  }

  /** Снять кадр и вернуть JPEG-блоб, уменьшенный до maxSide по длинной стороне */
  async capture({ maxSide = 2000, quality = 0.88 } = {}) {
    if (!this.stream) throw new Error('CAMERA_NOT_RUNNING');
    const vw = this.video.videoWidth;
    const vh = this.video.videoHeight;
    if (!vw || !vh) throw new Error('CAMERA_NO_FRAME');
    const scale = Math.min(1, maxSide / Math.max(vw, vh));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(vw * scale);
    canvas.height = Math.round(vh * scale);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(this.video, 0, 0, canvas.width, canvas.height);
    return await canvasToBlob(canvas, 'image/jpeg', quality);
  }
}

export function canvasToBlob(canvas, type = 'image/jpeg', quality = 0.88) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('Не удалось получить изображение'))), type, quality);
  });
}

async function loadBitmap(blob) {
  if (typeof createImageBitmap === 'function') {
    try {
      return await createImageBitmap(blob);
    } catch {
      /* упадём на <img> ниже */
    }
  }
  return await new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Не удалось прочитать изображение'));
    };
    img.src = url;
  });
}

/** Привести любое фото/файл к JPEG разумного размера и подготовить его к распознаванию.
 *  Предобработка (серое, контраст, обрезка полей, увеличение мелкого снимка) заметно помогает движку
 *  на реальных фото: см. app/js/image-prep.js и замер в docs/omr-benchmark.md. */
export async function prepareImageBlob(blob, { maxSide = 2000, quality = 0.88, preprocess = true, binarize = false, minWidth = 0 } = {}) {
  // minWidth по умолчанию 0: увеличение мелкой страницы на замерах только ухудшало распознавание
  // (см. docs/omr-prep.md), поэтому по умолчанию страницу не растягиваем.
  const bitmap = await loadBitmap(blob);
  const w = bitmap.width || bitmap.naturalWidth;
  const h = bitmap.height || bitmap.naturalHeight;
  const scale = Math.min(1, maxSide / Math.max(w, h));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(w * scale));
  canvas.height = Math.max(1, Math.round(h * scale));
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  if (bitmap.close) bitmap.close();

  let prepared = null;
  if (preprocess) {
    const frame = ctx.getImageData(0, 0, canvas.width, canvas.height);
    prepared = preprocessImageData(frame, { binarize, minWidth, maxSide: Math.max(minWidth, canvas.width) });
    if (prepared.width !== canvas.width || prepared.height !== canvas.height) {
      canvas.width = prepared.width;
      canvas.height = prepared.height;
    }
    ctx.putImageData(new ImageData(prepared.data, prepared.width, prepared.height), 0, 0);
  }

  const result = await canvasToBlob(canvas, 'image/jpeg', quality);
  result.prepStats = prepared?.stats || null;
  return result;
}

export function blobToObjectUrl(blob) {
  return URL.createObjectURL(blob);
}

/**
 * Маленькая обложка страницы для библиотеки: 220 px по ширине в JPEG.
 * Хранится прямо в записи пьесы (6–12 КБ), поэтому список библиотеки сразу показывает,
 * как выглядит снятая страница, и не требует отдельного хранилища картинок.
 */
export async function makeThumbnail(blob, { maxWidth = 220, quality = 0.62 } = {}) {
  const bitmap = await loadBitmap(blob);
  const w = bitmap.width || bitmap.naturalWidth;
  const h = bitmap.height || bitmap.naturalHeight;
  const scale = Math.min(1, maxWidth / Math.max(1, w));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(w * scale));
  canvas.height = Math.max(1, Math.round(h * scale));
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  if (bitmap.close) bitmap.close();
  return canvas.toDataURL('image/jpeg', quality);
}

export async function blobToBase64(blob) {
  const buffer = await blob.arrayBuffer();
  let binary = '';
  const bytes = new Uint8Array(buffer);
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/** Эвристики по снимку: размер, ориентация, контраст, найдена ли страница и обрезаны ли поля. */
export async function imageStats(blob) {
  const bitmap = await loadBitmap(blob);
  const w = bitmap.width || bitmap.naturalWidth;
  const h = bitmap.height || bitmap.naturalHeight;
  const scale = Math.min(1, 400 / Math.max(w, h));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(w * scale));
  canvas.height = Math.max(1, Math.round(h * scale));
  const ctx = canvas.getContext('2d');
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  if (bitmap.close) bitmap.close();
  const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const gray = grayFromRgba(data, canvas.width, canvas.height);
  const stats = grayStats(gray);
  const box = pageBounds(gray, canvas.width, canvas.height);
  const pageWidthRatio = box ? box.width / canvas.width : 1;
  const pageHeightRatio = box ? box.height / canvas.height : 1;
  return {
    width: w,
    height: h,
    meanLuminance: stats.meanLuminance,
    brightRatio: stats.brightRatio,
    darkRatio: stats.darkRatio,
    inkRatio: stats.inkRatio,
    contrastOk: stats.contrastOk,
    portrait: h >= w,
    pageFound: !!box,
    pageWidthRatio,
    pageHeightRatio,
    // Страница занимает мало места в кадре — стоит подсказать подойти ближе
    fillsFrame: pageWidthRatio > 0.55 || pageHeightRatio > 0.55,
  };
}