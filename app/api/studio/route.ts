import { env } from 'cloudflare:workers';
import { handleStudio } from '../../../lib/studio';
import type { StorageBucket } from '../../../lib/storage-types';
export function GET(request: Request) { return handleStudio(request, (env as unknown as { BUCKET: StorageBucket }).BUCKET); }
export function POST(request: Request) { return GET(request); }
