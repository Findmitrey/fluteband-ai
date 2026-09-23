// FluteBand AI — поиск установленного Chrome/Edge (общий помощник для инструментов разработчика).
import { existsSync } from 'node:fs';

const WINDOWS_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
];

const MAC_CANDIDATES = ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'];
const LINUX_CANDIDATES = ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'];

export function findChrome() {
  if (process.env.CHROME_PATH && existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH;
  const candidates = process.platform === 'win32'
    ? WINDOWS_CANDIDATES
    : process.platform === 'darwin'
      ? MAC_CANDIDATES
      : LINUX_CANDIDATES;
  return candidates.find((candidate) => existsSync(candidate)) || null;
}