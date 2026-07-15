import {
	closeSync,
	constants,
	fstatSync,
	lstatSync,
	openSync,
	readSync,
	realpathSync,
	statSync,
} from "node:fs";
import {
	chmod,
	mkdtemp,
	realpath,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import {
	basename,
	dirname,
	isAbsolute,
	join,
	relative,
	resolve,
	sep,
} from "node:path";
import { SHOPIFY_E2E_EXECUTION_CONTEXT_ENV } from "../config/execution-environment.cjs";
import { normalizeConfiguredOrigin } from "../role-states/configured-origin.cjs";
import { assertRoleName } from "../roles/role-name.cjs";
import {
	MAX_STORAGE_STATE_BYTES,
	type PlaywrightStorageState,
	serializeStorageState,
	validateStorageState,
} from "../storage-state/schema.cjs";

const CONTEXT_DIRECTORY_PREFIX = "shopify-e2e-context-";
const CONTEXT_FILENAME = "execution-context.json";
const DEFAULT_PACKAGE_ROOT = resolve(__dirname, "../..");
const MAX_CONTEXT_OVERHEAD_BYTES = 64 * 1024;
export const MAX_EXECUTION_CONTEXT_BYTES =
	MAX_STORAGE_STATE_BYTES + MAX_CONTEXT_OVERHEAD_BYTES;

interface FileIdentity {
	readonly device: number;
	readonly inode: number;
}

interface SerializedExecutionContext {
	readonly configIdentity: FileIdentity;
	readonly configPath: string;
	readonly normalizedOrigin: string;
	readonly projectIdentity: FileIdentity;
	readonly projectRoot: string;
	readonly role: string;
	readonly state: unknown;
	readonly testDir: string;
	readonly testDirIdentity: FileIdentity;
	readonly version: 1;
}

export interface PlaywrightExecutionContext {
	readonly configPath: string;
	readonly normalizedOrigin: string;
	readonly projectRoot: string;
	readonly role: string;
	readonly state: PlaywrightStorageState;
	readonly testDir: string;
}

export interface PlaywrightExecutionContextArtifact {
	readonly cleanup: () => Promise<void>;
	readonly contextPath: string;
}

export interface CreatePlaywrightExecutionContextOptions {
	readonly configPath: string;
	readonly normalizedOrigin: string;
	readonly packageRoot?: string;
	readonly projectRoot: string;
	readonly role: string;
	readonly state: unknown;
	readonly testDir: string;
}

export interface ReadPlaywrightExecutionContextOptions {
	readonly argv?: readonly string[];
	readonly environment?: NodeJS.ProcessEnv;
	readonly packageRoot?: string;
}

const isPathContained = ({
	candidate,
	parent,
}: {
	readonly candidate: string;
	readonly parent: string;
}): boolean => {
	const pathFromParent = relative(parent, candidate);
	return (
		pathFromParent === "" ||
		(!pathFromParent.startsWith(`..${sep}`) &&
			pathFromParent !== ".." &&
			!isAbsolute(pathFromParent))
	);
};

class PlaywrightExecutionContextError extends TypeError {
	public constructor(detail: string) {
		super(`Shopify E2E execution context is invalid: ${detail}`);
		this.name = "PlaywrightExecutionContextError";
	}
}

const invalidContext = (detail: string): PlaywrightExecutionContextError =>
	new PlaywrightExecutionContextError(detail);

const identityFromStats = (metadata: {
	readonly dev: number;
	readonly ino: number;
}): FileIdentity => ({ device: metadata.dev, inode: metadata.ino });

const identitiesMatch = (left: FileIdentity, right: FileIdentity): boolean =>
	left.device === right.device && left.inode === right.inode;

const assertOwnerOnly = (
	metadata: { readonly mode: number; readonly uid: number },
	label: string,
): void => {
	if ((metadata.mode & 0o077) !== 0) {
		throw invalidContext(`${label} permissions must be owner-only`);
	}
	if (
		typeof process.getuid === "function" &&
		metadata.uid !== process.getuid()
	) {
		throw invalidContext(`${label} owner does not match the current user`);
	}
};

const isStrictlyContained = (candidate: string, parent: string): boolean =>
	candidate !== parent && isPathContained({ candidate, parent });

const assertPhysicalPath = async (
	selectedPath: string,
	kind: "directory" | "file",
	label: string,
): Promise<{ readonly identity: FileIdentity; readonly path: string }> => {
	if (!isAbsolute(selectedPath)) {
		throw invalidContext(`${label} must be absolute`);
	}
	const physicalPath = await realpath(selectedPath).catch(() => {
		throw invalidContext(`${label} must resolve to a physical path`);
	});
	if (physicalPath !== selectedPath) {
		throw invalidContext(`${label} must be canonical`);
	}
	const metadata = await stat(physicalPath);
	if (
		(kind === "file" && !metadata.isFile()) ||
		(kind === "directory" && !metadata.isDirectory())
	) {
		throw invalidContext(`${label} must be a ${kind}`);
	}
	return { identity: identityFromStats(metadata), path: physicalPath };
};

const serializeContext = (context: SerializedExecutionContext): string => {
	let serialized: string;
	try {
		serialized = JSON.stringify(context);
	} catch {
		throw invalidContext("JSON serialization failed");
	}
	if (Buffer.byteLength(serialized) > MAX_EXECUTION_CONTEXT_BYTES) {
		throw invalidContext("size exceeds the bounded 64 MiB state limit");
	}
	return serialized;
};

export const createPlaywrightExecutionContext = async ({
	configPath,
	normalizedOrigin,
	packageRoot = DEFAULT_PACKAGE_ROOT,
	projectRoot,
	role,
	state,
	testDir,
}: CreatePlaywrightExecutionContextOptions): Promise<PlaywrightExecutionContextArtifact> => {
	const selectedRole = assertRoleName(role);
	const selectedOrigin = normalizeConfiguredOrigin(normalizedOrigin);
	if (selectedOrigin !== normalizedOrigin) {
		throw invalidContext("store origin must already be normalized");
	}
	const selectedState = JSON.parse(serializeStorageState(state)) as unknown;
	const [project, config, tests, physicalPackageRoot, physicalTemporaryRoot] =
		await Promise.all([
			assertPhysicalPath(projectRoot, "directory", "project root"),
			assertPhysicalPath(configPath, "file", "config path"),
			assertPhysicalPath(testDir, "directory", "test directory"),
			realpath(packageRoot),
			realpath(tmpdir()),
		]);
	if (!isStrictlyContained(config.path, project.path)) {
		throw invalidContext("config path must be inside the project root");
	}
	if (!isStrictlyContained(tests.path, project.path)) {
		throw invalidContext("test directory must be inside the project root");
	}
	if (
		isPathContained({
			candidate: physicalTemporaryRoot,
			parent: project.path,
		}) ||
		isPathContained({
			candidate: physicalTemporaryRoot,
			parent: physicalPackageRoot,
		})
	) {
		throw invalidContext(
			"system temporary root must be outside project and package roots",
		);
	}

	const payload: SerializedExecutionContext = {
		configIdentity: config.identity,
		configPath: config.path,
		normalizedOrigin: selectedOrigin,
		projectIdentity: project.identity,
		projectRoot: project.path,
		role: selectedRole,
		state: selectedState,
		testDir: tests.path,
		testDirIdentity: tests.identity,
		version: 1,
	};
	const serialized = serializeContext(payload);
	const directoryPath = await mkdtemp(
		join(physicalTemporaryRoot, CONTEXT_DIRECTORY_PREFIX),
	);
	const contextPath = join(directoryPath, CONTEXT_FILENAME);
	try {
		await chmod(directoryPath, 0o700);
		await writeFile(contextPath, serialized, { flag: "wx", mode: 0o600 });
		await chmod(contextPath, 0o600);
	} catch (error) {
		await rm(directoryPath, { force: true, recursive: true });
		throw error;
	}

	return Object.freeze({
		cleanup: () => rm(directoryPath, { force: true, recursive: true }),
		contextPath,
	});
};

const readBoundedDescriptor = (
	descriptor: number,
	expectedSize: number,
): string => {
	if (expectedSize <= 0 || expectedSize > MAX_EXECUTION_CONTEXT_BYTES) {
		throw invalidContext("file size exceeds the bounded 64 MiB state limit");
	}
	const buffer = Buffer.allocUnsafe(expectedSize + 1);
	let total = 0;
	while (total < buffer.length) {
		const bytesRead = readSync(
			descriptor,
			buffer,
			total,
			buffer.length - total,
			total,
		);
		if (bytesRead === 0) break;
		total += bytesRead;
	}
	if (total !== expectedSize) {
		throw invalidContext("file identity or size changed while reading");
	}
	return buffer.subarray(0, total).toString("utf8");
};

const readContextFile = (contextPath: string): unknown => {
	const inspected = lstatSync(contextPath);
	if (inspected.isSymbolicLink()) {
		throw invalidContext("file must not be a symbolic link");
	}
	if (!inspected.isFile()) {
		throw invalidContext("path must be a regular file");
	}
	assertOwnerOnly(inspected, "file");
	if (inspected.size > MAX_EXECUTION_CONTEXT_BYTES) {
		throw invalidContext("file size exceeds the bounded 64 MiB state limit");
	}

	const noFollow = "O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0;
	const descriptor = openSync(contextPath, constants.O_RDONLY | noFollow);
	try {
		const opened = fstatSync(descriptor);
		if (!opened.isFile()) throw invalidContext("path must be a regular file");
		assertOwnerOnly(opened, "file");
		if (
			!identitiesMatch(identityFromStats(inspected), identityFromStats(opened))
		) {
			throw invalidContext("file identity changed before opening");
		}
		const source = readBoundedDescriptor(descriptor, opened.size);
		try {
			return JSON.parse(source) as unknown;
		} catch {
			throw invalidContext("file contains malformed JSON");
		}
	} finally {
		closeSync(descriptor);
	}
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const readString = (record: Record<string, unknown>, key: string): string => {
	const value = record[key];
	if (typeof value !== "string" || value.length === 0) {
		throw invalidContext(`${key} is malformed`);
	}
	return value;
};

const readIdentity = (
	record: Record<string, unknown>,
	key: string,
): FileIdentity => {
	const value = record[key];
	if (
		!isRecord(value) ||
		!Number.isSafeInteger(value.device) ||
		!Number.isSafeInteger(value.inode)
	) {
		throw invalidContext(`${key} is malformed`);
	}
	return { device: value.device as number, inode: value.inode as number };
};

const assertExactKeys = (record: Record<string, unknown>): void => {
	const expected = [
		"configIdentity",
		"configPath",
		"normalizedOrigin",
		"projectIdentity",
		"projectRoot",
		"role",
		"state",
		"testDir",
		"testDirIdentity",
		"version",
	].sort();
	if (
		Object.keys(record).sort().join("\0") !== expected.join("\0") ||
		record.version !== 1
	) {
		throw invalidContext("schema is malformed");
	}
};

const assertCurrentIdentity = (
	selectedPath: string,
	expected: FileIdentity,
	kind: "directory" | "file",
	label: string,
): string => {
	if (!isAbsolute(selectedPath))
		throw invalidContext(`${label} must be absolute`);
	let physicalPath: string;
	try {
		physicalPath = realpathSync(selectedPath);
	} catch {
		throw invalidContext(`${label} physical identity is unavailable`);
	}
	if (physicalPath !== selectedPath) {
		throw invalidContext(`${label} must remain canonical`);
	}
	const metadata = statSync(physicalPath);
	if (
		(kind === "file" && !metadata.isFile()) ||
		(kind === "directory" && !metadata.isDirectory()) ||
		!identitiesMatch(identityFromStats(metadata), expected)
	) {
		throw invalidContext(`${label} physical identity changed`);
	}
	return physicalPath;
};

const assertCanonicalTemporaryParent = (
	contextPath: string,
	packageRoot: string,
): void => {
	if (!isAbsolute(contextPath)) {
		throw invalidContext(
			"pointer must be an absolute path under the temporary root",
		);
	}
	const physicalTemporaryRoot = realpathSync(tmpdir());
	const parent = dirname(contextPath);
	if (
		basename(contextPath) !== CONTEXT_FILENAME ||
		dirname(parent) !== physicalTemporaryRoot ||
		!basename(parent).startsWith(CONTEXT_DIRECTORY_PREFIX)
	) {
		throw invalidContext(
			"pointer parent must be under the canonical temporary root",
		);
	}
	const parentInspected = lstatSync(parent);
	if (parentInspected.isSymbolicLink() || !parentInspected.isDirectory()) {
		throw invalidContext("pointer parent must be a non-symlinked directory");
	}
	assertOwnerOnly(parentInspected, "parent directory");
	if (realpathSync(parent) !== parent) {
		throw invalidContext("pointer parent must remain canonical");
	}
	const physicalPackageRoot = realpathSync(packageRoot);
	if (isPathContained({ candidate: parent, parent: physicalPackageRoot })) {
		throw invalidContext("pointer parent must be outside the package root");
	}
};

const assertCanonicalConfigArgument = (
	argv: readonly string[],
	configPath: string,
): void => {
	const argumentsAfterScript = argv.slice(2);
	const exposesInitialInvocation = argumentsAfterScript[0] === "test";
	if (!exposesInitialInvocation) {
		const exposesConfigOption = argumentsAfterScript.some(
			(argument) =>
				argument === "--config" ||
				argument === "-c" ||
				argument.startsWith("--config=") ||
				argument.startsWith("-c="),
		);
		if (!exposesConfigOption) return;
		throw invalidContext(
			"initial process must expose one exact --config argument",
		);
	}
	if (
		argumentsAfterScript[1] !== "--config" ||
		argumentsAfterScript[2] !== configPath ||
		argumentsAfterScript[3] !== "--workers=1"
	) {
		throw invalidContext(
			"initial process must expose one exact --config argument",
		);
	}
	const seenControls = new Set<string>();
	for (let index = 4; index < argumentsAfterScript.length; index += 2) {
		const control = argumentsAfterScript[index];
		const value = argumentsAfterScript[index + 1];
		if (
			(control !== "--grep" && control !== "--grep-invert") ||
			seenControls.has(control) ||
			typeof value !== "string" ||
			value.length === 0
		) {
			throw invalidContext(
				"initial process has an invalid config argument shape or unsupported control",
			);
		}
		seenControls.add(control);
	}
};

const deepFreeze = <Value,>(value: Value): Value => {
	if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
		return value;
	}
	for (const child of Object.values(value as Record<string, unknown>)) {
		deepFreeze(child);
	}
	return Object.freeze(value);
};

const readPlaywrightExecutionContextUnchecked = ({
	argv = process.argv,
	environment = process.env,
	packageRoot = DEFAULT_PACKAGE_ROOT,
}: ReadPlaywrightExecutionContextOptions = {}): PlaywrightExecutionContext => {
	const contextPath = environment[SHOPIFY_E2E_EXECUTION_CONTEXT_ENV];
	if (typeof contextPath !== "string" || contextPath.length === 0) {
		throw invalidContext("reserved pointer is missing");
	}
	assertCanonicalTemporaryParent(contextPath, packageRoot);
	const parsed = readContextFile(contextPath);
	if (!isRecord(parsed)) throw invalidContext("schema is malformed");
	assertExactKeys(parsed);

	const projectRoot = assertCurrentIdentity(
		readString(parsed, "projectRoot"),
		readIdentity(parsed, "projectIdentity"),
		"directory",
		"project root",
	);
	const configPath = assertCurrentIdentity(
		readString(parsed, "configPath"),
		readIdentity(parsed, "configIdentity"),
		"file",
		"config path",
	);
	const testDir = assertCurrentIdentity(
		readString(parsed, "testDir"),
		readIdentity(parsed, "testDirIdentity"),
		"directory",
		"test directory",
	);
	if (!isStrictlyContained(configPath, projectRoot)) {
		throw invalidContext("config path escaped the project root");
	}
	if (!isStrictlyContained(testDir, projectRoot)) {
		throw invalidContext("test directory escaped the project root");
	}
	if (
		isPathContained({ candidate: dirname(contextPath), parent: projectRoot })
	) {
		throw invalidContext("pointer parent must be outside the project root");
	}

	const normalizedOrigin = normalizeConfiguredOrigin(
		readString(parsed, "normalizedOrigin"),
	);
	if (normalizedOrigin !== parsed.normalizedOrigin) {
		throw invalidContext("stored origin must already be normalized");
	}
	const currentOrigin = environment.SHOPIFY_STORE_URL;
	if (
		typeof currentOrigin !== "string" ||
		normalizeConfiguredOrigin(currentOrigin) !== normalizedOrigin
	) {
		throw invalidContext("configured store origin changed");
	}
	const role = assertRoleName(readString(parsed, "role"));
	const state = validateStorageState(parsed.state);
	assertCanonicalConfigArgument(argv, configPath);

	return deepFreeze({
		configPath,
		normalizedOrigin,
		projectRoot,
		role,
		state,
		testDir,
	});
};

export const readPlaywrightExecutionContext = (
	options: ReadPlaywrightExecutionContextOptions = {},
): PlaywrightExecutionContext => {
	try {
		return readPlaywrightExecutionContextUnchecked(options);
	} catch (error) {
		if (error instanceof PlaywrightExecutionContextError) throw error;
		throw invalidContext("validation could not complete safely");
	}
};
