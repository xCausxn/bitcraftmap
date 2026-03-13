import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ fetch }) => {
	try {
		const response = await fetch('https://bitjita.com/api/wind');

		if (!response.ok) {
			return json({ error: 'Failed to fetch wind data' }, { status: response.status });
		}

		const data = await response.json();
		return json(data);
	} catch {
		return json({ error: 'Failed to fetch wind data' }, { status: 500 });
	}
};
