import type { RequestedModelChain } from "../core/model-chain";
import type { EffectiveRoutePlan, RoutingContext } from "../core/types";

/**
 * endpoint 固有のrequest形式と routing core の境界。
 * 将来 Responses API / Anthropic Messages 等を追加する場合はこの interface を実装する。
 */
export interface EndpointAdapter<TRequest> {
	/** raw JSON を検証し、endpoint 固有のrequestとして扱える形にする。 */
	parseRequest(body: unknown): TRequest;
	extractRoutingContext(request: TRequest): RoutingContext;
	getRequestedModelChain(request: TRequest): RequestedModelChain;
	/** 元のrequestを保持したまま、plan に必要なfieldだけをpatchした新しいrequestを返す。 */
	applyRoutePlan(request: TRequest, plan: EffectiveRoutePlan): TRequest;
}
