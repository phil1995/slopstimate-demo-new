<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import Brand from './Brand.svelte';
  import Icon from './Icon.svelte';
  import Modal from './Modal.svelte';
  import { RoomController } from './room.svelte';
  import { summarizeEstimates } from './estimates';
  import { DEFAULT_DECK, FIBONACCI, TSHIRT } from '../shared/protocol';
  import type { PublicMember } from '../shared/protocol';
  import {
    deck as validateDeck,
    text as validateText,
  } from '../shared/validation';
  let { id }: { id: string } = $props();
  const c = new RoomController(untrack(() => id));
  let name = $state('');
  let copied = $state(false);
  let shareOpen = $state(false);
  let settingsOpen = $state(false);
  let renameOpen = $state(false);
  let title = $state('');
  let choices = $state('');
  let settingsError = $state('');
  let confirmation = $state<'delete' | 'leave' | 'remove' | null>(null);
  let removingMember = $state<PublicMember | null>(null);
  let copyTimer: ReturnType<typeof setTimeout>;
  const members = $derived(c.room?.members ?? []);
  const summary = $derived(
    c.memberId || c.isAdmin ? summarizeEstimates(c.room) : null,
  );
  const ready = $derived(c.connection === 'connected' && !c.busy);
  onMount(() => {
    void c.start();
    return () => {
      c.destroy();
      clearTimeout(copyTimer);
    };
  });
  async function copyLink() {
    try {
      await navigator.clipboard.writeText(`${location.origin}/r/${id}`);
      copied = true;
      clearTimeout(copyTimer);
      copyTimer = setTimeout(() => (copied = false), 2500);
    } catch {
      shareOpen = true;
    }
  }
  function openSettings() {
    title = c.room!.title;
    choices = c.room!.deck.join('\n');
    settingsError = '';
    c.error = '';
    settingsOpen = true;
  }
  async function saveSettings(event: SubmitEvent) {
    event.preventDefault();
    settingsError = '';
    try {
      const nextTitle = validateText(title, 'Title', 80, 'Planning Poker');
      const nextDeck = validateDeck(choices.split(/\r?\n/));
      if (await c.admin('settings', { title: nextTitle, deck: nextDeck }))
        settingsOpen = false;
    } catch (error) {
      settingsError =
        error instanceof Error ? error.message : 'Check your settings.';
    }
  }
  async function join(event: SubmitEvent) {
    event.preventDefault();
    if (await c.join(name)) name = '';
  }
  async function rename(event: SubmitEvent) {
    event.preventDefault();
    if (await c.join(name)) renameOpen = false;
  }
  async function confirm() {
    const success =
      confirmation === 'delete'
        ? await c.delete()
        : confirmation === 'remove' && removingMember
          ? await c.removeMember(removingMember.id)
          : await c.leave();
    if (success) confirmation = null;
  }
</script>

<svelte:head
  ><title>{c.room?.title ?? 'Your room'} — Slopstimate</title></svelte:head
>
<div class="site-shell room-shell">
  <header class="site-header">
    <Brand />
    <div class="header-meta">
      <span class="small-pill">PLANNING POKER</span><a
        class="quiet-link"
        href="https://github.com/phil1995/Slopstimate"
        target="_blank"
        rel="noreferrer">GitHub <Icon name="arrow" size={15} /></a
      >
    </div>
  </header>
  {#if c.loading}
    <main id="main-content" class="empty-page" aria-live="polite">
      <div class="spinner"></div>
      <h1>Making room for you…</h1>
      <p>Loading the current estimation.</p>
    </main>
  {:else if c.notFound}
    <main id="main-content" class="empty-page">
      <div class="empty-icon"><Icon name="link" size={30} /></div>
      <span class="eyebrow">ROOM NOT FOUND</span>
      <h1>This room isn’t here.</h1>
      <p>
        The link may be incorrect, or the admin may have deleted the room.<br
        />A fresh start is only a click away.
      </p>
      <a class="button primary" href="/"
        >Create a new room <Icon name="arrow" /></a
      >
    </main>
  {:else if !c.room}
    <main id="main-content" class="empty-page">
      <h1>We couldn’t reach the room.</h1>
      <p role="alert">{c.error}</p>
      <button class="button primary" onclick={() => c.start()}
        >Try again <Icon name="reset" /></button
      >
    </main>
  {:else}
    <main id="main-content" class="room-main">
      <div class="room-heading">
        <div>
          <div class="eyebrow">YOUR TEAM’S ESTIMATION ROOM</div>
          <h1>{c.room.title}</h1>
          <div class="room-subtitle">
            <span class="connection" class:live={c.connection === 'connected'}
              ><span class="tiny-dot"></span>{{
                connected: 'Live connection',
                connecting: 'Connecting…',
                reconnecting: 'Reconnecting…',
                offline: 'You’re offline',
                join: 'Join to connect',
              }[c.connection]}</span
            >{#if c.isAdmin}<span class="admin-badge">You’re the admin</span
              >{/if}
          </div>
        </div>
        <div class="heading-actions">
          <button class="button secondary" onclick={copyLink}
            ><Icon name={copied ? 'check' : 'link'} size={18} />{copied
              ? 'Link copied'
              : 'Invite team'}</button
          >{#if c.isAdmin}<button
              class="icon-button settings-button"
              aria-label="Room settings"
              onclick={openSettings}
              disabled={!ready}><Icon name="sliders" /></button
            >{/if}
        </div>
      </div>
      {#if c.error}<div class="alert room-alert" role="alert">
          <span>{c.error}</span><button
            class="icon-button"
            aria-label="Dismiss error"
            onclick={() => (c.error = '')}
            ><Icon name="close" size={16} /></button
          >
        </div>{/if}
      {#if c.connection === 'offline' || c.connection === 'reconnecting'}<div
          class="connection-notice"
          role="status"
        >
          {c.connection === 'offline'
            ? 'You’re offline. Your last saved estimation is shown below.'
            : 'Reconnecting to the room. We’ll catch up with the current estimation automatically.'}<button
            class="text-button"
            onclick={c.connect}>Retry now</button
          >
        </div>{/if}
      <div class="room-content">
        <section class="voting-panel panel" aria-labelledby="vote-title">
          {#if !c.hasMembership && !c.isAdmin}
            <div class="join-content">
              <h2 id="vote-title">Join the room</h2>
              <form class="join-form" onsubmit={join}>
                <label for="join-name">Your display name</label>
                <input
                  id="join-name"
                  bind:value={name}
                  placeholder="e.g. Alex"
                  maxlength="80"
                  autocomplete="nickname"
                  required
                />
                <button
                  class="button primary"
                  type="submit"
                  disabled={c.busy || !name.trim()}
                  >{c.busy ? 'Joining…' : 'Join the room'}<Icon
                    name="arrow"
                  /></button
                >
              </form>
            </div>
          {:else}
            <div class="round-content">
              <h2 id="vote-title">Choose an estimate</h2>
              <div
                class="vote-deck"
                role="group"
                aria-label="Choose your estimate"
              >
                {#each c.room.deck as vote (vote)}
                  <button
                    class="vote-card"
                    class:selected={!c.room.revealed && c.selected === vote}
                    class:long-option={vote.length > 3}
                    aria-label={vote === '?'
                      ? 'Skip this estimate (?)'
                      : `Vote ${vote}`}
                    title={vote === '?' ? 'Skip this estimate' : vote}
                    aria-pressed={!c.room.revealed && c.selected === vote}
                    disabled={!ready || !c.hasMembership || c.room.revealed}
                    onclick={() => c.vote(vote)}><strong>{vote}</strong></button
                  >
                {/each}
              </div>
              {#if c.isAdmin && !c.hasMembership}
                <form class="facilitator-join" onsubmit={join}>
                  <label for="join-name">Join to vote</label>
                  <input
                    id="join-name"
                    bind:value={name}
                    placeholder="Your display name"
                    maxlength="80"
                    autocomplete="nickname"
                    required
                  />
                  <button
                    class="button secondary"
                    type="submit"
                    disabled={c.busy || !name.trim()}>Join the room</button
                  >
                </form>
              {/if}
            </div>
            {#if !c.room.revealed || c.isAdmin}<div class="round-footer">
                <div class="round-actions">
                  {#if !c.room.revealed}<button
                      class="button primary"
                      disabled={!ready}
                      onclick={() => c.reveal()}
                      ><Icon name="eye" size={18} />Reveal estimates</button
                    >{/if}
                  {#if c.isAdmin}<button
                      class="button secondary"
                      disabled={!ready}
                      onclick={() => c.admin('reset')}
                      ><Icon name="reset" size={18} />Reset estimation</button
                    >{/if}
                </div>
              </div>{/if}
          {/if}
        </section>
        <div class="estimation-results" class:revealed={summary !== null}>
          <section
            class="participants-panel panel"
            aria-labelledby="team-title"
          >
            <div class="participants-heading">
              <h2 id="team-title">
                Participants <span class="count-badge">{members.length}</span>
              </h2>
              {#if c.hasMembership}<div class="identity-actions">
                  <button
                    class="text-button"
                    onclick={() => {
                      name = c.name;
                      c.error = '';
                      renameOpen = true;
                    }}
                    disabled={!ready}>Change name</button
                  >
                  <button
                    class="text-button"
                    onclick={() => {
                      c.error = '';
                      confirmation = 'leave';
                    }}
                    disabled={!ready}>Leave room</button
                  >
                </div>{/if}
            </div>
            <ul class="roster" aria-label="Participants and estimates">
              {#each members as member (member.id)}
                <li class="member-row">
                  <span class="member-name">{member.name}</span>
                  <div class="member-actions">
                    {#if c.room.revealed}<span
                        class="revealed-vote"
                        aria-label={`${member.name}: ${member.vote === '?' ? 'skipped' : (member.vote ?? 'no estimate')}`}
                        title={member.vote === '?'
                          ? 'Skipped'
                          : (member.vote ?? 'No estimate')}
                        >{member.vote ?? '—'}</span
                      >
                    {:else if member.voted}<span
                        class="member-voted"
                        aria-label={`${member.name}: voted`}
                        ><Icon name="check" size={16} /></span
                      >
                    {:else}<span
                        class="member-pending"
                        aria-label={`${member.name}: not voted`}>—</span
                      >{/if}
                    {#if c.isAdmin}<button
                        class="icon-button remove-member-button"
                        aria-label={`Remove ${member.name} from room`}
                        disabled={!ready}
                        onclick={() => {
                          removingMember = member;
                          c.error = '';
                          confirmation = 'remove';
                        }}><Icon name="close" size={16} /></button
                      >{/if}
                  </div>
                </li>
              {:else}<li class="empty-roster">No participants yet.</li>{/each}
            </ul>
          </section>
          {#if summary}
            <section
              class="average-panel panel"
              aria-labelledby="average-title"
              aria-live="polite"
            >
              <h2 id="average-title">Average estimate</h2>
              <p class="average-value">
                {summary.mean === null
                  ? '—'
                  : summary.mean.toLocaleString(undefined, {
                      maximumFractionDigits: 2,
                    })}
              </p>
              <div class="disagreement-row">
                <h3>Disagreement</h3>
                <span
                  class="disagreement-badge"
                  class:low={summary.disagreement === 'Low'}
                  class:medium={summary.disagreement === 'Medium'}
                  class:high={summary.disagreement === 'High'}
                  >{summary.disagreement ?? '—'}</span
                >
              </div>
              <div class="vote-summary">
                <h3>Vote summary</h3>
                <ul aria-label="Vote counts">
                  {#each summary.votes as result (result.vote)}
                    <li>{result.label}</li>
                  {:else}
                    <li class="empty-summary">No votes yet.</li>
                  {/each}
                </ul>
              </div>
            </section>
          {/if}
        </div>
      </div>
    </main>
  {/if}
  <footer class="site-footer">
    <span>Slopstimate</span><a href="/" class="quiet-link"
      >Start a new room <Icon name="arrow" size={15} /></a
    >
  </footer>
</div>
<Modal
  open={shareOpen}
  title="Invite your team"
  onClose={() => (shareOpen = false)}
  ><p>Share this link. It gives your team participant access.</p>
  <label for="room-link">Room link</label><input
    id="room-link"
    value={`${location.origin}/r/${id}`}
    readonly
    onclick={(event) => event.currentTarget.select()}
  />
  <p class="microcopy">Select the link and copy it to your clipboard.</p></Modal
>
<Modal
  open={settingsOpen}
  title="Room settings"
  onClose={() => {
    if (!c.busy) settingsOpen = false;
  }}
  ><form onsubmit={saveSettings}>
    <label for="room-title">Room name</label><input
      id="room-title"
      bind:value={title}
      maxlength="160"
      placeholder="Planning Poker"
    /><label for="deck-options">Deck options</label><textarea
      id="deck-options"
      bind:value={choices}
      rows="3"
      required></textarea>
    <p class="input-help">
      One option per line. 2–20 unique choices, up to 16 characters each.
    </p>
    <div class="preset-buttons">
      <button
        class="button secondary compact"
        type="button"
        onclick={() => (choices = DEFAULT_DECK.join('\n'))}>Team default</button
      >
      <button
        class="button secondary compact"
        type="button"
        onclick={() => (choices = FIBONACCI.join('\n'))}>Fibonacci</button
      ><button
        class="button secondary compact"
        type="button"
        onclick={() => (choices = TSHIRT.join('\n'))}>T-shirt sizes</button
      >
    </div>
    <div class="settings-notice">
      <Icon name="reset" size={18} />
      <p>Changing the deck resets the estimation and clears current votes.</p>
    </div>
    {#if settingsError || c.error}<p role="alert" class="alert">
        {settingsError || c.error}
      </p>{/if}<button
      class="button primary full-width"
      type="submit"
      disabled={!ready}>{c.busy ? 'Saving…' : 'Save settings'}</button
    >
  </form>
  <div class="danger-zone">
    <p>Deleting a room removes its members and current votes permanently.</p>
    <button
      class="text-button danger-text"
      onclick={() => {
        settingsOpen = false;
        c.error = '';
        confirmation = 'delete';
      }}
      disabled={!ready}>Delete this room</button
    >
  </div></Modal
>
<Modal
  open={renameOpen}
  title="Change your name"
  onClose={() => {
    if (!c.busy) renameOpen = false;
  }}
  ><form onsubmit={rename}>
    <label for="new-name">Your display name</label><input
      id="new-name"
      bind:value={name}
      maxlength="80"
      required
      autocomplete="nickname"
    />{#if c.error}<p class="alert" role="alert">{c.error}</p>{/if}<button
      class="button primary full-width"
      type="submit"
      disabled={!ready || !name.trim()}>Save name</button
    >
  </form></Modal
>
<Modal
  open={confirmation !== null}
  title={confirmation === 'delete'
    ? 'Delete this room?'
    : confirmation === 'remove'
      ? `Remove ${removingMember?.name ?? 'member'}?`
      : 'Leave the room?'}
  onClose={() => {
    if (!c.busy) confirmation = null;
  }}
  ><p>
    {confirmation === 'delete'
      ? 'This permanently deletes the room, its members, and its current votes. The shared link will stop working. This cannot be undone.'
      : confirmation === 'remove'
        ? `${removingMember?.name ?? 'This member'} will be removed from the room, including their current vote. All their connected tabs will be disconnected. They can join again with a name using the room link.`
        : 'Your membership and current vote will be removed, and this device will forget your participant identity. You can join again with a new name.'}
  </p>
  {#if confirmation === 'leave' && c.isAdmin}<p class="input-help">
      You’ll keep admin access in this browser and can still facilitate.
    </p>{/if}{#if c.error}<p class="alert" role="alert">{c.error}</p>{/if}
  <div class="confirmation-actions">
    <button
      class="button secondary"
      disabled={c.busy}
      onclick={() => (confirmation = null)}>Cancel</button
    ><button
      class="button"
      class:danger={confirmation === 'delete' || confirmation === 'remove'}
      class:primary={confirmation === 'leave'}
      disabled={!ready}
      onclick={confirm}
      >{c.busy
        ? 'Working…'
        : confirmation === 'delete'
          ? 'Delete permanently'
          : confirmation === 'remove'
            ? 'Remove member'
            : 'Leave and forget me'}</button
    >
  </div></Modal
>
