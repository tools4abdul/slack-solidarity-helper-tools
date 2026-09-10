import { describe, it, expect } from 'vitest';
import { parseTickerSize, tickerShape } from './ticker-size.js';

function params(value?: string): URLSearchParams {
	const p = new URLSearchParams();
	if (value !== undefined) p.set('ticker', value);
	return p;
}

describe('parseTickerSize', () => {
	it('defaults to fit when the parameter is missing', () => {
		expect(parseTickerSize(params())).toBe('fit');
	});

	it('defaults to fit when the parameter is empty', () => {
		expect(parseTickerSize(params(''))).toBe('fit');
	});

	it('defaults to fit when the parameter names no known size', () => {
		expect(parseTickerSize(params('enormous'))).toBe('fit');
	});

	it('defaults to fit for an inherited Object property name', () => {
		expect(parseTickerSize(params('constructor'))).toBe('fit');
		expect(parseTickerSize(params('toString'))).toBe('fit');
	});

	it('reads widescreen', () => {
		expect(parseTickerSize(params('widescreen'))).toBe('widescreen');
	});

	it('reads fit', () => {
		expect(parseTickerSize(params('fit'))).toBe('fit');
	});

	it('ignores case and surrounding whitespace', () => {
		expect(parseTickerSize(params(' WideScreen '))).toBe('widescreen');
	});
});

describe('tickerShape', () => {
	it('starts the sign fitted by default, still offering 16:9', () => {
		expect(tickerShape(params())).toEqual({ ratio: '16 / 9', fit: true });
	});

	it('starts the sign at 16:9 for ?ticker=widescreen', () => {
		expect(tickerShape(params('widescreen'))).toEqual({ ratio: '16 / 9', fit: false });
	});

	it('starts the sign fitted for ?ticker=fit', () => {
		expect(tickerShape(params('fit'))).toEqual({ ratio: '16 / 9', fit: true });
	});
});
