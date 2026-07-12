import { isAbsolute, relative, sep } from "node:path";

export function isPathContained(parent: string, candidate: string): boolean {
	const pathFromParent = relative(parent, candidate);
	return (
		pathFromParent === "" ||
		(!pathFromParent.startsWith(`..${sep}`) &&
			pathFromParent !== ".." &&
			!isAbsolute(pathFromParent))
	);
}
