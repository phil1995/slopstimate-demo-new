<script lang="ts">
  import type { Snippet } from 'svelte';
  import Icon from './Icon.svelte';
  let {
    open,
    title,
    onClose,
    children,
  }: { open: boolean; title: string; onClose: () => void; children: Snippet } =
    $props();
  let dialog = $state<HTMLDialogElement>();
  $effect(() => {
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    else if (!open && dialog.open) dialog.close();
  });
</script>

<dialog
  bind:this={dialog}
  oncancel={(event) => {
    event.preventDefault();
    onClose();
  }}
  aria-label={title}
>
  <div class="modal-header">
    <h2>{title}</h2>
    <button class="icon-button" onclick={onClose} aria-label="Close dialog"
      ><Icon name="close" /></button
    >
  </div>
  {@render children()}
</dialog>
