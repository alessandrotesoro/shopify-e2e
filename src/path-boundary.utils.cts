import { isAbsolute, relative, sep } from "node:path";

export interface IsPathContainedArgs {
	readonly candidate: string;
	readonly parent: string;
}

export const isPathContained = ({
	candidate,
	parent,
}: IsPathContainedArgs): boolean => {
	const pathFromParent = relative(parent, candidate);
	return (
		pathFromParent === "" ||
		(!pathFromParent.startsWith(`..${sep}`) &&
			pathFromParent !== ".." &&
			!isAbsolute(pathFromParent))
	);
};
