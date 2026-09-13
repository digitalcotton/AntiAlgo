import type { APIRoute } from 'astro';
import { getAuth } from '../../lib/auth';

/** Better Auth's mount point. Every /auth/* request is handed to the library. */
export const prerender = false;

export const ALL: APIRoute = async (context) => getAuth().handler(context.request);
