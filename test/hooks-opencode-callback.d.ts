declare module "../hooks/opencode-callback.js" {
	const transform: (ctx: any) => Promise<any>;
	export default transform;

	export function buildContinuationInstruction(
		payload: any,
		routedSessionKey: string,
	): string;
	export function reconcileRunArtifactFromHook(payload: any): any;
	export function buildInternalControlNote(): string;
	export function buildOpencodeSessionKey(payload: any): string;
}
