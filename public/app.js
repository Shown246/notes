import { createApi } from './api.js';

const view = document.querySelector('#view');
const navigation = document.querySelector('#navigation');
const account = document.querySelector('#account');
let user = null;
let context;
let expiryTimer;
const api = createApi(() => logout('Your session expired or was invalidated. Please log in again.'));

function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}
function button(text, action) {
  const node = element('button', text);
  node.type = 'button';
  node.addEventListener('click', action);
  return node;
}
function message(parent, text = '', error = false) {
  const node = element('p', text, error ? 'error' : 'status');
  node.setAttribute('role', error ? 'alert' : 'status');
  parent.append(node);
  return node;
}
function showError(node, error) {
  node.className = 'error';
  node.setAttribute('role', 'alert');
  node.textContent = [error.status === 403 ? 'Access denied. Your account does not have permission.' : error.message,
    ...(error.details || []).map(item => `${item.field || 'Input'}: ${item.message}`),
    error.requestId ? `Request ID: ${error.requestId}` : ''].filter(Boolean).join('\n');
}
function begin(title) {
  context?.abort();
  context = new AbortController();
  view.classList.remove('auth-view');
  view.replaceChildren(element('p', user ? 'YOUR WORKSPACE' : 'WELCOME TO SECURE NOTES', 'eyebrow'), element('h2', title));
  view.focus();
  return context;
}
function active(ctx) { return context === ctx && !ctx.signal.aborted; }
async function run(ctx, status, task) {
  status.className = 'status';
  status.setAttribute('role', 'status');
  status.textContent = 'Loading…';
  try {
    await task();
    if (active(ctx) && status.textContent === 'Loading…') status.textContent = '';
  } catch (error) {
    if (active(ctx) && error.name !== 'AbortError') showError(status, error);
  }
}
function request(ctx, path, options = {}) {
  return api.request(path, { ...options, signal: ctx.signal });
}
function interests(value) { return value.trim() === '' ? [] : value.split(','); }

// Every form uses native constraints plus the API's shared validation contract.
function form(parent, ctx, fields, submitText, save) {
  const node = element('form');
  const fieldset = element('fieldset');
  const inputs = {};
  for (const field of fields) {
    const label = element('label', field.label);
    const input = element(field.type === 'textarea' ? 'textarea' : field.type === 'select' ? 'select' : 'input');
    if (input.tagName === 'INPUT') input.type = field.type || 'text';
    input.name = field.name;
    input.id = `field-${field.name}`;
    label.htmlFor = input.id;
    if (field.options) for (const value of field.options) {
      const option = element('option', value);
      option.value = value;
      input.append(option);
    }
    input.value = field.value ?? '';
    input.required = field.required ?? true;
    if (field.max) input.maxLength = field.max;
    if (field.min) input.minLength = field.min;
    if (field.autocomplete) input.autocomplete = field.autocomplete;
    input.disabled = field.disabled || false;
    fieldset.append(label);
    if (field.type === 'password') {
      const wrapper = element('div', undefined, 'password-field');
      const toggle = button('', () => {
        input.type = input.type === 'password' ? 'text' : 'password';
        updateToggle();
      });
      toggle.className = 'password-toggle';
      toggle.setAttribute('aria-controls', input.id);
      const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      icon.setAttribute('viewBox', '0 0 24 24');
      icon.setAttribute('fill', 'none');
      icon.setAttribute('stroke', 'currentColor');
      icon.setAttribute('stroke-width', '1.8');
      icon.setAttribute('aria-hidden', 'true');
      for (const path of ['M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z', 'M9 12a3 3 0 1 0 6 0 3 3 0 0 0-6 0']) {
        const shape = document.createElementNS(icon.namespaceURI, 'path');
        shape.setAttribute('d', path);
        icon.append(shape);
      }
      const slash = document.createElementNS(icon.namespaceURI, 'path');
      slash.setAttribute('d', 'M3 3 21 21');
      icon.append(slash);
      toggle.append(icon);
      function updateToggle() {
        const visible = input.type === 'text';
        toggle.setAttribute('aria-label', visible ? 'Hide password' : 'Show password');
        toggle.title = visible ? 'Hide password' : 'Show password';
        slash.style.display = visible ? '' : 'none';
      }
      updateToggle();
      wrapper.append(input, toggle);
      fieldset.append(wrapper);
    } else {
      fieldset.append(input);
    }
    inputs[field.name] = input;
  }
  const submit = element('button', submitText);
  submit.type = 'submit';
  fieldset.append(submit);
  const status = message(node);
  node.prepend(fieldset);
  node.addEventListener('submit', event => {
    event.preventDefault();
    if (fieldset.disabled) return;
    fieldset.disabled = true;
    const values = Object.fromEntries(Object.entries(inputs).map(([key, input]) => [key, input.value]));
    void run(ctx, status, async () => {
      try { await save(values, status); }
      finally { if (active(ctx)) fieldset.disabled = false; }
    });
  });
  parent.append(node);
  return node;
}
const nameField = value => ({ name: 'name', label: 'Name', max: 100, value, autocomplete: 'name' });
const emailField = value => ({ name: 'email', label: 'Email', type: 'email', value, autocomplete: 'username' });
const passwordField = (required = true, login = false) => ({ name: 'password', label: required ? 'Password (12–128 characters)' : 'New password (leave blank to keep current)', type: 'password', min: 12, max: 128, required, autocomplete: login ? 'current-password' : 'new-password' });
const interestsField = value => ({ name: 'interests', label: 'Interests (comma-separated, up to 10; 40 characters each)', required: false, value: value?.join(', ') });

function updateNavigation(selected) {
  document.body.classList.toggle('signed-in', Boolean(user));
  account.textContent = user ? `${user.name} · ${user.email} · ${user.role}` : 'Your own corner of the internet.';
  navigation.replaceChildren();
  const items = user ? [['notes', 'My notes'], ['profile', 'Profile'], ['posts', 'Posts']] : [['login', 'Log in'], ['register', 'Register'], ['posts', 'Posts']];
  if (user?.role === 'admin') items.push(['users', 'Manage users'], ['all-notes', 'All notes'], ['report', 'Interests report']);
  for (const [key, label] of items) {
    const control = button(label, () => void navigate(key));
    if (key === selected) control.setAttribute('aria-current', 'page');
    navigation.append(control);
  }
  if (user) navigation.append(button('Log out', () => logout('You have logged out.')));
}
function logout(text) {
  clearTimeout(expiryTimer);
  api.setToken(null);
  user = null;
  void navigate('login', text);
}
async function navigate(page, notice = '') {
  updateNavigation(page);
  if (!user) {
    if (page === 'posts') postsView();
    else authView(page === 'register', notice);
    return;
  }
  const ctx = begin('Loading account');
  const status = message(view);
  await run(ctx, status, async () => {
    const result = await request(ctx, '/auth/me');
    if (!active(ctx)) return;
    user = result.data;
    updateNavigation(page);
    if (['users', 'all-notes', 'report'].includes(page) && user.role !== 'admin') {
      begin('Access denied');
      message(view, 'Your account does not have permission to open this view.', true);
      return;
    }
    if (page === 'profile') profileView();
    else if (page === 'posts') postsView();
    else if (page === 'users') usersView();
    else if (page === 'all-notes') notesView(true);
    else if (page === 'report') reportView();
    else notesView();
  });
}
function authView(register, notice) {
  const ctx = begin(register ? 'Register' : 'Log in');
  view.classList.add('auth-view');
  view.append(element('p', register ? 'A fresh page for your ideas. Create your account to get started.' : 'Welcome back. Pick up where your thoughts left off.', 'view-description'));
  if (notice) message(view, notice);
  form(view, ctx, register ? [nameField(), emailField(), passwordField(), interestsField()] : [emailField(), passwordField(true, true)], register ? 'Create account' : 'Log in', async values => {
    if (register) {
      await request(ctx, '/auth/register', { method: 'POST', anonymous: true, body: { ...values, interests: interests(values.interests) } });
      if (active(ctx)) await navigate('login', 'Account created. Log in with your new credentials.');
    } else {
      const { data } = await request(ctx, '/auth/login', { method: 'POST', anonymous: true, body: values });
      if (!active(ctx)) return;
      api.setToken(data.accessToken);
      user = data.user;
      clearTimeout(expiryTimer);
      expiryTimer = setTimeout(() => logout('Your session expired. Please log in again.'), data.expiresIn * 1000);
      await navigate('notes');
    }
  });
  view.append(element('p', 'For your privacy, you?ll need to log in again after refreshing.', 'session-note'));
}
function profileView() {
  const ctx = begin('Profile');
  form(view, ctx, [nameField(user.name), interestsField(user.interests)], 'Save profile', async values => {
    const result = await request(ctx, '/auth/me', { method: 'PATCH', body: { name: values.name, interests: interests(values.interests) } });
    if (!active(ctx)) return;
    user = result.data;
    updateNavigation('profile');
    profileView();
    message(view, 'Profile saved. Interests were normalized by the server.');
  });
}

// Each independent list owns its cursor. Next replaces the current bounded page.
function pagedList(parent, ctx, path, renderRow, emptyText, onPage) {
  const controls = element('div', undefined, 'actions');
  const sizeLabel = element('label', 'Page size');
  const size = element('select');
  for (const value of [5, 20, 50, 100]) {
    const option = element('option', String(value));
    option.value = String(value);
    size.append(option);
  }
  size.value = '20';
  size.className = 'page-size';
  size.id = 'page-size';
  sizeLabel.htmlFor = size.id;
  const rows = element('div', undefined, 'card-list');
  const status = message(parent);
  let cursor = null;
  let nextCursor = null;
  let busy = false;
  const first = button('First page / Refresh', () => void load(null));
  const next = button('Next', () => void load(nextCursor));
  next.disabled = true;
  controls.append(first, next);
  parent.append(sizeLabel, size, controls, rows);
  size.addEventListener('change', () => void load(null));
  async function load(target = cursor) {
    if (busy || !active(ctx)) return;
    busy = true;
    first.disabled = next.disabled = size.disabled = true;
    rows.setAttribute('aria-busy', 'true');
    rows.replaceChildren();
    // A failed page must not leave a cursor from a previously displayed page.
    nextCursor = null;
    await run(ctx, status, async () => {
      const query = new URLSearchParams({ limit: size.value });
      if (target) query.set('cursor', target);
      const result = await request(ctx, `${path}?${query}`);
      if (!active(ctx)) return;
      cursor = target;
      nextCursor = result.pagination.hasMore ? result.pagination.nextCursor : null;
      onPage?.(result);
      for (const row of result.data) rows.append(renderRow(row));
      if (!result.data.length) message(rows, emptyText);
    });
    busy = false;
    if (active(ctx)) {
      rows.setAttribute('aria-busy', 'false');
      first.disabled = size.disabled = false;
      next.disabled = !nextCursor;
    }
  }
  void load(null);
  return () => load(null);
}
function article(title) {
  const node = element('article');
  node.append(element('h3', title));
  return node;
}
function notesView(admin = false) {
  const ctx = begin(admin ? 'All notes (read only)' : 'My notes');
  if (!admin) view.append(button('Create note', () => noteEditor()));
  pagedList(view, ctx, admin ? '/admin/notes' : '/notes', note => {
    const row = article(note.title);
    if (admin) row.append(element('p', `Owner: ${note.ownerId}`));
    row.append(button('Open note', () => void openNote(note.id, admin)));
    return row;
  }, 'No notes on this page.');
}
async function openNote(id, admin) {
  const ctx = begin(admin ? 'Read note' : 'Edit note');
  view.append(button('Back to notes', () => void navigate(admin ? 'all-notes' : 'notes')));
  const status = message(view);
  await run(ctx, status, async () => {
    const { data } = await request(ctx, `${admin ? '/admin' : ''}/notes/${encodeURIComponent(id)}`);
    if (!active(ctx)) return;
    if (admin) {
      view.append(element('h3', data.title), element('p', `Owner: ${data.ownerId}`), element('p', data.content, 'content'));
    } else noteEditor(data);
  });
}
function noteEditor(note) {
  const ctx = begin(note ? 'Edit note' : 'Create note');
  view.append(button('Back to notes', () => void navigate('notes')));
  form(view, ctx, [{ name: 'title', label: 'Title', max: 200, value: note?.title },
    { name: 'content', label: 'Content', type: 'textarea', max: 20000, required: false, value: note?.content }], 'Save note', async values => {
    await request(ctx, note ? `/notes/${encodeURIComponent(note.id)}` : '/notes', { method: note ? 'PATCH' : 'POST', body: values });
    if (active(ctx)) await navigate('notes');
  });
  if (note) confirmDelete(view, ctx, 'Delete note', 'Permanently delete this note?', `/notes/${encodeURIComponent(note.id)}`, () => navigate('notes'));
}
function confirmDelete(parent, ctx, label, prompt, path, after) {
  const area = element('div', undefined, 'danger-zone');
  const trigger = button(label, () => {
    area.replaceChildren(element('p', prompt));
    const status = message(area);
    const confirm = button('Confirm deletion', () => {
      confirm.disabled = true;
      void run(ctx, status, async () => {
        try {
          await request(ctx, path, { method: 'DELETE' });
          if (active(ctx)) await after();
        } finally { if (active(ctx)) confirm.disabled = false; }
      });
    });
    area.append(confirm, button('Cancel deletion', () => area.replaceChildren(trigger)));
    confirm.focus();
  });
  area.append(trigger);
  parent.append(area);
}
function completeList(ctx, path, render, empty, after = () => {}) {
  const status = message(view);
  const results = element('div');
  view.append(results);
  void run(ctx, status, async () => {
    const response = await request(ctx, path);
    if (!active(ctx)) return;
    after(response);
    if (!response.data.length) message(results, empty);
    for (const item of response.data) results.append(render(item));
  });
}
function postsView(authorId, complete = false) {
  const ctx = begin(authorId ? 'Author posts' : 'Posts');
  if (authorId) view.append(button('Back to all posts', () => void navigate('posts')));
  else if (user) {
    view.append(button('Create post', () => postEditor()));
    view.append(button('My author page', () => postsView(user.id)));
  }
  const author = element('p');
  view.append(author);
  if (authorId) view.append(button(complete ? 'Show paginated posts' : 'Show all author posts', () => postsView(authorId, !complete)));
  const path = authorId ? `/users/${encodeURIComponent(authorId)}/posts` : '/posts';
  const render = post => {
    const row = article(post.title);
    row.append(element('p', post.body, 'content'), button(`Posts by ${post.authorId}`, () => postsView(post.authorId)));
    return row;
  };
  const after = result => {
    if (result.author) author.textContent = `Author: ${result.author.name} (${result.author.id})`;
  };
  if (complete) completeList(ctx, `${path}/all`, render, 'This author has no posts.', after);
  else pagedList(view, ctx, path, render, 'No posts on this page.', after);
}
function postEditor() {
  const ctx = begin('Create post');
  view.append(button('Back to posts', () => void navigate('posts')));
  form(view, ctx, [{ name: 'title', label: 'Title', max: 200 }, { name: 'body', label: 'Body', type: 'textarea', max: 10000 }], 'Publish post', async values => {
    await request(ctx, '/posts', { method: 'POST', body: values });
    if (active(ctx)) await navigate('posts');
  });
}
function usersView() {
  const ctx = begin('Manage users');
  view.append(button('Create user', () => userEditor()));
  pagedList(view, ctx, '/admin/users', entry => {
    const row = article(entry.name);
    row.append(element('p', `${entry.email} · ${entry.role}`), button('Edit user', () => void openUser(entry.id)));
    return row;
  }, 'No users on this page.');
}
async function openUser(id) {
  const ctx = begin('Loading user');
  const status = message(view);
  view.append(button('Back to users', () => void navigate('users')));
  await run(ctx, status, async () => {
    const { data } = await request(ctx, `/admin/users/${encodeURIComponent(id)}`);
    if (active(ctx)) userEditor(data);
  });
}
function userEditor(entry) {
  const ctx = begin(entry ? 'Edit user' : 'Create user');
  const self = entry?.id === user.id;
  view.append(button('Back to users', () => void navigate('users')));
  if (self) message(view, 'You cannot change your own role or delete your own account. Resetting your password ends this session.');
  const fields = [nameField(entry?.name), emailField(entry?.email), passwordField(!entry), interestsField(entry?.interests),
    { name: 'role', label: 'Role', type: 'select', options: ['user', 'admin'], value: entry?.role || 'user', disabled: self }];
  form(view, ctx, fields, 'Save user', async values => {
    const body = { ...values, interests: interests(values.interests) };
    if (entry && !body.password) delete body.password;
    if (self) delete body.role;
    await request(ctx, entry ? `/admin/users/${encodeURIComponent(entry.id)}` : '/admin/users', { method: entry ? 'PATCH' : 'POST', body });
    if (!active(ctx)) return;
    if (self && body.password) logout('Your password was reset. Log in with your new password.');
    else await navigate('users');
  });
  if (entry && !self) confirmDelete(view, ctx, 'Delete user', `Permanently delete ${entry.name}, their notes, and their posts?`, `/admin/users/${encodeURIComponent(entry.id)}`, () => navigate('users'));
}
function reportView(complete = false) {
  const ctx = begin('Interests report');
  message(view, complete ? 'All interest groups and all members.' : 'Exact member counts with previews of up to five users per group.');
  view.append(button(complete ? 'Show paginated previews' : 'Show all groups and members', () => reportView(!complete)));
  const render = group => {
    const row = article(group.interest);
    row.append(element('p', `Members: ${group.userCount}`));
    const list = element('ul');
    for (const member of group.users ?? group.usersPreview) list.append(element('li', `${member.name} (${member.id})`));
    row.append(list);
    if (group.hasMoreUsers) row.append(element('p', 'More members exist; this is a bounded preview.'));
    return row;
  };
  if (complete) completeList(ctx, '/admin/reports/users-by-interest/all', render, 'No interest groups.');
  else pagedList(view, ctx, '/admin/reports/users-by-interest', render, 'No interest groups on this page.');
}
void navigate('login');
