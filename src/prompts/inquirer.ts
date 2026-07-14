import { confirm, input, select } from "@inquirer/prompts";

export interface PromptChoice<Value> {
	readonly description?: string;
	readonly disabled?: boolean | string;
	readonly name: string;
	readonly value: Value;
}

interface PromptContext {
	readonly input?: NodeJS.ReadableStream;
	readonly output?: NodeJS.WritableStream;
	readonly signal: AbortSignal;
}

export interface SelectPromptOptions<Value> extends PromptContext {
	readonly choices: readonly PromptChoice<Value>[];
	readonly message: string;
}

export interface InputPromptOptions extends PromptContext {
	readonly message: string;
	readonly validate?: (
		value: string,
	) => boolean | string | Promise<boolean | string>;
}

export interface ConfirmPromptOptions extends PromptContext {
	readonly default?: boolean;
	readonly message: string;
}

export interface PromptFunctions {
	readonly confirm: (options: ConfirmPromptOptions) => Promise<boolean>;
	readonly input: (options: InputPromptOptions) => Promise<string>;
	readonly select: <Value>(
		options: SelectPromptOptions<Value>,
	) => Promise<Value>;
}

const contextFrom = ({
	input: inputStream,
	output,
	signal,
}: PromptContext) => ({
	input: inputStream,
	output,
	signal,
});

export const inquirerPrompts: PromptFunctions = {
	confirm: (options) =>
		confirm(
			{
				default: options.default,
				message: options.message,
			},
			contextFrom(options),
		),
	input: (options) =>
		input(
			{ message: options.message, validate: options.validate },
			contextFrom(options),
		),
	select: (options) =>
		select(
			{ choices: options.choices, message: options.message },
			contextFrom(options),
		),
};
