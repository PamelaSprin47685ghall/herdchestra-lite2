// Public scope names are independent of provider tool IDs and host agent IDs.
export const SCOPE_ID_PATTERN = "^[A-Za-z][A-Za-z0-9]*(?:[-_][A-Za-z0-9]+)*$";
export const MAX_SCOPE_ID_LENGTH = 48;
const pattern = new RegExp(SCOPE_ID_PATTERN);

export function validScopeId(value) {
	return typeof value === "string" && value.length <= MAX_SCOPE_ID_LENGTH && pattern.test(value);
}

export function scopeTitle(id) {
	if (typeof id !== "string" || id === "") return "";
	if (id.startsWith("/")) return id;
	return id.replace(/([a-z0-9])([A-Z])/g, "$1 $2").split(/[-_ ]+/).map((word) =>
		word.charAt(0).toUpperCase() + word.slice(1),
	).join(" ");
}

export function publicScopeId(record) {
	if (typeof record?.path === "string" && record.path !== "") return record.path;
	if (typeof record?.scopeId === "string" && record.scopeId !== "") return `/${record.scopeId}`;
	return Number.isInteger(record?.openSeq) ? `/scope-${record.openSeq}` : "/scope";
}
