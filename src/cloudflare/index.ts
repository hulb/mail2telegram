export interface CloudflareZone {
    id: string;
    name: string;
    accountId: string;
}

export interface CloudflareRuleAction {
    type: 'forward' | 'worker';
    value: string;
}

interface CloudflareAPIResponse<T> {
    success: boolean;
    errors: Array<{ code: number; message: string }>;
    result: T;
    result_info?: {
        page?: number;
        per_page?: number;
        total_count?: number;
        total_pages?: number;
    };
}

// 分页终止判断：优先用 total_pages；缺失时用 total_count/per_page 计算；
// 无分页信息（如 workers scripts 端点一次返回全部）→ 不再翻页。
export function hasMorePages(info: CloudflareAPIResponse<unknown>['result_info'], fetched: number, currentPage: number): boolean {
    if (!info) {
        return false;
    }
    if (info.total_pages != null) {
        return currentPage < info.total_pages;
    }
    if (info.total_count != null && info.total_count > 0) {
        const perPage = info.per_page ?? (fetched || 50);
        const totalPages = Math.ceil(info.total_count / perPage);
        return currentPage < totalPages;
    }
    return false;
}

const API_BASE = 'https://api.cloudflare.com/client/v4';
// 兜底模式：匹配任意 *.mx.cloudflare.net（如 route1/2/3、linda、jose 等）
const EMAIL_ROUTING_MX_PATTERN = /^[\w-]+\.mx\.cloudflare\.net\.?$/i;

export function validateEmailPrefix(prefix: string): boolean {
    return /^[a-z0-9][\w.-]{0,62}$/i.test(prefix);
}

export function isValidAddressLength(address: string): boolean {
    return address.length <= 90;
}

interface DNSMXRecord {
    name: string;
    content: string;
    meta?: Record<string, unknown>;
}

export function filterEmailRoutingMXRecords(records: DNSMXRecord[]): string[] {
    const domains = new Set<string>();
    for (const record of records) {
        // meta.email_routing 是 Email Routing 托管记录的权威标记；content 模式匹配作为兼容兜底
        if (record.meta?.email_routing === true || EMAIL_ROUTING_MX_PATTERN.test(record.content)) {
            domains.add(record.name);
        }
    }
    return [...domains].sort();
}

function cfErrorMessage(res: Response, data: CloudflareAPIResponse<unknown> | null): string {
    const status = `Cloudflare API error (HTTP ${res.status})`;
    const messages = data?.errors?.map(e => e.message).filter(Boolean).join('; ');
    return messages ? `${status}: ${messages}` : status;
}

async function cfFetchAllPages<T>(token: string, path: string): Promise<T[]> {
    const all: T[] = [];
    // MAX_PAGES 保护：防止无分页信息端点（返回全部但忽略 page 参数）导致的死循环
    const MAX_PAGES = 20;
    for (let page = 1; page <= MAX_PAGES; page++) {
        const sep = path.includes('?') ? '&' : '?';
        const res = await fetch(`${API_BASE}${path}${sep}page=${page}&per_page=50`, {
            headers: { Authorization: `Bearer ${token}` },
        });
        const data = await res.json().catch(() => null) as CloudflareAPIResponse<T[]> | null;
        if (!res.ok || !data) {
            throw new Error(cfErrorMessage(res, data));
        }
        if (!data.success) {
            throw new Error(cfErrorMessage(res, data));
        }
        all.push(...data.result);
        if (!hasMorePages(data.result_info, data.result.length, page)) {
            return all;
        }
    }
    return all;
}

interface ZoneResult {
    id: string;
    name: string;
    account: { id: string };
}

export async function listZones(token: string): Promise<CloudflareZone[]> {
    const zones = await cfFetchAllPages<ZoneResult>(token, '/zones?status=active');
    return zones.map(z => ({ id: z.id, name: z.name, accountId: z.account.id }));
}

export async function listEmailDomains(token: string, zone: CloudflareZone): Promise<string[]> {
    const records = await cfFetchAllPages<DNSMXRecord>(token, `/zones/${zone.id}/dns_records?type=MX`);
    return filterEmailRoutingMXRecords(records);
}

interface DestinationAddressResult {
    email: string;
    verified: string | null;
}

export async function listDestinationAddresses(token: string, accountId: string): Promise<string[]> {
    const addresses = await cfFetchAllPages<DestinationAddressResult>(token, `/accounts/${accountId}/email/routing/addresses`);
    return addresses.filter(a => a.verified !== null).map(a => a.email).sort();
}

interface WorkerScriptResult {
    id: string;
    handlers?: string[];
}

export async function listWorkers(token: string, accountId: string): Promise<string[]> {
    const scripts = await cfFetchAllPages<WorkerScriptResult>(token, `/accounts/${accountId}/workers/scripts`);
    // handlers 缺失时不过滤（API 字段可能缺省），存在时只保留实现了 email() handler 的 worker
    return scripts.filter(s => !s.handlers || s.handlers.includes('email')).map(s => s.id).sort();
}

interface RoutingRuleResult {
    matchers: Array<{ type: string; value?: string }>;
}

export async function listRuleAddresses(token: string, zoneId: string): Promise<string[]> {
    const rules = await cfFetchAllPages<RoutingRuleResult>(token, `/zones/${zoneId}/email/routing/rules`);
    return rules.flatMap(r => r.matchers).filter(m => m.type === 'literal' && m.value).map(m => m.value as string);
}

export interface RoutingRule {
    id: string;
    address: string;
    actionLabel: string;
    source: string;
}

interface ApiRoutingRule {
    id: string;
    matchers: Array<{ type: string; field?: string; value?: string }>;
    actions: Array<{ type: string; value?: string[] }>;
    source?: string;
}

export function mapRoutingRuleResult(rule: ApiRoutingRule): RoutingRule | null {
    const matcher = rule.matchers.find(m => m.type === 'literal');
    const action = rule.actions?.[0];
    if (!matcher?.value || !action) {
        return null;
    }
    const actionValue = action.value?.[0] || '';
    const actionLabel = action.type === 'forward'
        ? `→ ${actionValue}`
        : action.type === 'worker'
            ? `→ worker ${actionValue}`
            : '→ drop';
    return {
        id: rule.id,
        address: matcher.value,
        actionLabel,
        source: rule.source || 'api',
    };
}

export async function listRoutingRules(token: string, zoneId: string): Promise<RoutingRule[]> {
    const rules = await cfFetchAllPages<ApiRoutingRule>(token, `/zones/${zoneId}/email/routing/rules`);
    return rules.map(mapRoutingRuleResult).filter((r): r is RoutingRule => r !== null);
}

export async function deleteRule(token: string, zoneId: string, ruleId: string): Promise<void> {
    const res = await fetch(`${API_BASE}/zones/${zoneId}/email/routing/rules/${ruleId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
    });
    const data = await res.json().catch(() => null) as CloudflareAPIResponse<unknown> | null;
    if (!res.ok || !data || !data.success) {
        throw new Error(cfErrorMessage(res, data));
    }
}

export async function createRule(token: string, zoneId: string, address: string, action: CloudflareRuleAction): Promise<void> {
    const res = await fetch(`${API_BASE}/zones/${zoneId}/email/routing/rules`, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            name: 'Created by mail2telegram bot',
            enabled: true,
            matchers: [{ type: 'literal', field: 'to', value: address }],
            actions: [{ type: action.type, value: [action.value] }],
        }),
    });
    const data = await res.json().catch(() => null) as CloudflareAPIResponse<unknown> | null;
    if (!res.ok || !data || !data.success) {
        throw new Error(cfErrorMessage(res, data));
    }
}
