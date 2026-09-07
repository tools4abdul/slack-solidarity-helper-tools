<script lang="ts">
	import '../app.css';
	import { page } from '$app/state';
	import { resolve } from '$app/paths';
	import UserMenu, { type MenuItem } from '$lib/components/nav/UserMenu.svelte';
	import ThemeToggle from '$lib/components/nav/ThemeToggle.svelte';
	import { documentTitle, resolveSiteName } from '$lib/site-name.js';

	let { data, children } = $props();

	// The header <h1> shows the page's own name; the browser tab shows
	// "<page> — <site>". Both come from the same `pageTitle`, set once per route
	// in its load function, so a route can never disagree with itself.
	const siteName = $derived(resolveSiteName(data.siteName));
	const pageTitle = $derived<string>(page.data.pageTitle ?? siteName);

	// Back-to-dashboard arrow on every non-root page (/pending, /settings).
	// Not for signed-out readers: /policies is public, and an arrow pointing at
	// a page that would bounce them to Slack OAuth is a dead end, not a way back.
	const signedIn = $derived(data.signedIn);
	const showBackLink = $derived(signedIn && page.url.pathname !== '/');

	const menuItems = $derived<MenuItem[]>(
		data.isAdmin
			? [
					{ href: '/pending', label: 'Pending applicants' },
					{ href: '/members', label: 'Member lookup' },
					{ href: '/channel-chapter-diff', label: 'Channel vs. chapter' },
					{ href: '/turfs', label: 'Turf checkout' },
					{ href: '/turfs/organizer', label: 'Turf right now' },
					{ href: '/turfs/activity', label: 'Turf activity' },
					{ href: '/settings', label: 'Settings' },
				]
			: [],
	);

	// Turf checkout is the one page a non-admin has any reason to open, and
	// until now nothing in the app linked them to it — the menu is admin-only,
	// so a volunteer had to arrive via the /turfs Slack command or a pasted URL.
	//
	// Shown as a plain link rather than by giving non-admins the dropdown: a
	// menu holding exactly one item hides that item behind a click and reads as
	// though more is being withheld. Admins keep the dropdown, which already
	// lists this page, so nobody sees it twice.
	//
	// Signed-in only, for the reason the back-link has: /policies is public, and
	// a link that bounces a signed-out reader into Slack OAuth is a dead end.
	// Blocked users still see it — access.ts redirects them to an explanation,
	// which is friendlier than a link that silently is not there.
	const showTurfLink = $derived(signedIn && !data.isAdmin);
</script>

<!-- One <title> for the whole app. Individual pages used to set their own and
     drifted: / said "Dashboard" while /pending said "A4M Slack Invite Queue"
     and three routes set none at all, so the tab showed a URL. -->
<svelte:head>
	<title>{documentTitle(page.data.pageTitle, siteName)}</title>
</svelte:head>

<div class="app-shell">
	<header class="app-header">
		<div class="header-left">
			{#if showBackLink}
				<a class="back-link" href={resolve('/')} aria-label="Back to dashboard">
					<svg
						viewBox="0 0 24 24"
						width="20"
						height="20"
						fill="none"
						stroke="currentColor"
						stroke-width="2.5"
						stroke-linecap="round"
						stroke-linejoin="round"
						aria-hidden="true"
					>
						<path d="M15 18l-6-6 6-6" />
					</svg>
				</a>
			{/if}
			<h1>{pageTitle}</h1>
		</div>
		<div class="user-info">
			<ThemeToggle mode={data.themeMode} />
			{#if signedIn}
				{#if showTurfLink}
					<a
						class="header-link"
						href={resolve('/turfs')}
						aria-current={page.url.pathname === '/turfs' ? 'page' : undefined}>Turf checkout</a
					>
				{/if}
				<UserMenu items={menuItems} />
				<span class="user-greeting">
					Logged in as <span class="user-name">{data.userName}</span>
				</span>
				<form method="POST" action="/auth/logout">
					<button type="submit" class="logout-btn">Log out</button>
				</form>
			{:else}
				<a class="logout-btn" href={resolve('/auth/slack')}>Sign in with Slack</a>
			{/if}
		</div>
	</header>

	{@render children?.()}

	<footer class="app-footer">
		<a href="{resolve('/policies')}#privacy">Privacy</a>
		<span aria-hidden="true">·</span>
		<a href="{resolve('/policies')}#security">Security</a>
	</footer>
</div>

<style>
	.app-shell {
		display: contents;
	}
	.app-header {
		background: var(--color-header-bg);
		padding: 16px 24px;
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 16px;
		flex-wrap: wrap;
	}
	.header-left {
		display: flex;
		align-items: center;
		gap: 10px;
	}
	.back-link {
		display: inline-flex;
		align-items: center;
		padding: 4px;
		margin-left: -6px;
		border-radius: var(--radius-md);
		color: var(--color-header-text);
		opacity: 0.8;
	}
	.back-link:hover,
	.back-link:focus-visible {
		opacity: 1;
		background: color-mix(in srgb, var(--color-header-text) 10%, transparent);
	}
	.app-header h1 {
		font-size: 1.1rem;
		font-weight: 600;
		color: var(--color-header-text);
		margin: 0;
	}
	.user-info {
		font-size: var(--font-size-base);
		color: color-mix(in srgb, var(--color-header-text) 75%, transparent);
		display: flex;
		align-items: center;
		gap: 14px;
	}
	.user-greeting {
		display: inline-flex;
		align-items: baseline;
		gap: 4px;
	}
	.user-name {
		color: var(--color-gold);
		font-weight: 600;
	}
	.logout-btn {
		background: transparent;
		color: var(--color-header-text);
		border: 1px solid color-mix(in srgb, var(--color-header-text) 40%, transparent);
		border-radius: var(--radius-md);
		padding: 4px 10px;
		font-size: var(--font-size-sm);
		font-family: inherit;
		cursor: pointer;
	}
	.logout-btn:hover {
		background: color-mix(in srgb, var(--color-header-text) 10%, transparent);
		border-color: color-mix(in srgb, var(--color-header-text) 80%, transparent);
	}
	/* Deliberately not styled as a button: it sits next to "Log out", and two
	   identical-looking controls beside each other invites the wrong click. */
	.header-link {
		color: var(--color-header-text);
		text-decoration: none;
		font-size: var(--font-size-sm);
		border-bottom: 1px solid color-mix(in srgb, var(--color-header-text) 40%, transparent);
		padding-bottom: 1px;
		white-space: nowrap;
	}
	.header-link:hover,
	.header-link[aria-current='page'] {
		border-bottom-color: var(--color-header-text);
	}
	.header-link[aria-current='page'] {
		color: var(--color-gold);
		border-bottom-color: var(--color-gold);
	}
	.app-footer {
		display: flex;
		justify-content: center;
		align-items: center;
		gap: 8px;
		padding: 20px 24px 28px;
		font-size: var(--font-size-sm);
		color: var(--color-text-faint);
	}
	.app-footer a {
		color: var(--color-text-muted);
	}
</style>
