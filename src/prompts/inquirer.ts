import { checkbox, confirm, select } from "@inquirer/prompts";

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

export interface CheckboxPromptOptions<Value>
	extends SelectPromptOptions<Value> {
	readonly required?: boolean;
}

export interface ConfirmPromptOptions extends PromptContext {
	readonly default?: boolean;
	readonly message: string;
}

export interface PromptFunctions {
	readonly checkbox: <Value>(
		options: CheckboxPromptOptions<Value>,
	) => Promise<Value[]>;
	readonly confirm: (options: ConfirmPromptOptions) => Promise<boolean>;
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
	checkbox: (options) =>
		checkbox(
			{
				choices: options.choices,
				message: options.message,
				required: options.required,
			},
			contextFrom(options),
		),
	confirm: (options) =>
		confirm(
			{
				default: options.default,
				message: options.message,
			},
			contextFrom(options),
		),
	select: (options) =>
		select(
			{ choices: options.choices, message: options.message },
			contextFrom(options),
		),
};
