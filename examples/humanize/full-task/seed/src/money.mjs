export function toCents(value) {
	return Math.trunc(Number(value) * 100);
}

export function formatMoney(cents) {
	return (cents / 100).toFixed(2);
}
