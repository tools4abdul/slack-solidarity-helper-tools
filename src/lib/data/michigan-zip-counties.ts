import zipCounties from './michigan-zip-counties.json';

const ZIP_TO_COUNTY: Record<string, string> = zipCounties;

/** Michigan county for a 5-digit zip, or null if the zip isn't in Michigan. */
export function countyForZip(zip: string | null | undefined): string | null {
	if (!zip) return null;
	const trimmed = zip.trim().slice(0, 5);
	return ZIP_TO_COUNTY[trimmed] ?? null;
}
