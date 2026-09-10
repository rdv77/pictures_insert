export type Asset = { id: string; name: string; kind: 'photo' | 'poster'; url: string; created: number; size?: number };
export type Job = { id: string; photo: Asset; poster: Asset; status: 'pending' | 'running' | 'done' | 'error'; created: number; updated: number; error?: string; result?: string };
export type Config = { model: string; mode: string; instruction: string };
export function assignments(count: number, posterCount: number, mode: string, random = Math.random): number[] {
  if (!Number.isInteger(count) || count < 0 || !Number.isInteger(posterCount) || posterCount < 1) throw new Error('Нет макетов');
  const out = Array.from({ length: count }, (_, i) => mode === 'random' ? Math.floor(random() * posterCount) : i % posterCount);
  if (mode === 'balanced') for (let i = out.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [out[i], out[j]] = [out[j], out[i]]; }
  return out;
}
export function imageType(bytes: Uint8Array): string | null {
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if ([137,80,78,71,13,10,26,10].every((b, i) => bytes[i] === b)) return 'image/png';
  if (new TextDecoder().decode(bytes.slice(0,4)) === 'RIFF' && new TextDecoder().decode(bytes.slice(8,12)) === 'WEBP') return 'image/webp';
  return null;
}
export function filename(name: string) { return Array.from(name, c => c.charCodeAt(0) < 32 || '/\\<>:"|?*'.includes(c) ? '_' : c).join('').slice(0,120) || 'image'; }
export function prompt(instruction: string) {
  return `Image 1 is the original photograph to edit. Image 2 is the replacement poster artwork, not a scene reference. Replace the old poster surfaces specified by the user in image 1 with the exact artwork from image 2. Preserve the original framing, scene, camera angle, people, objects and lighting. Fit the artwork naturally to the surface perspective and cylinder curvature, preserving shadows, reflections and occlusions. Keep the artwork lettering, logos, colors and layout as faithful as possible. Do not invent new poster text. Return only the edited photograph. User instruction: ${instruction}`;
}
