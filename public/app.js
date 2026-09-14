document.addEventListener('DOMContentLoaded', () => {
  // Socket.IO instance
  const socket = io();

  // State
  let currentUser = null;
  let activeRoomId = 'general';
  let activeRoomName = 'general';
  let activeRoomType = 'channel'; // 'channel', 'dm', 'group'
  let allUsers = [];
  let userGroups = [];
  let pendingAttachment = null;
  let typingTimeout = null;
  let isTyping = false;
  let unreadCounts = {};

  // DOM Elements
  const authModal = document.getElementById('authModal');
  const tabLoginBtn = document.getElementById('tabLoginBtn');
  const tabRegisterBtn = document.getElementById('tabRegisterBtn');
  const formLogin = document.getElementById('formLogin');
  const formRegister = document.getElementById('formRegister');
  const loginUsername = document.getElementById('loginUsername');
  const loginPassword = document.getElementById('loginPassword');
  const regUsername = document.getElementById('regUsername');
  const regPassword = document.getElementById('regPassword');
  const regLanId = document.getElementById('regLanId');
  const btnLogout = document.getElementById('btnLogout');
  const btnMobileMenu = document.getElementById('btnMobileMenu');
  const sidebar = document.querySelector('.sidebar');

  // Device Selection & Mode State
  const deviceModal = document.getElementById('deviceModal');
  const btnSelectPhone = document.getElementById('btnSelectPhone');
  const btnSelectLaptop = document.getElementById('btnSelectLaptop');
  const btnChangeDeviceMode = document.getElementById('btnChangeDeviceMode');
  const deviceModeBadgeIcon = document.getElementById('deviceModeBadgeIcon');
  const deviceModeBadgeText = document.getElementById('deviceModeBadgeText');

  function setDeviceMode(mode) {
    document.body.classList.remove('device-mode-phone', 'device-mode-laptop');
    document.body.classList.add(`device-mode-${mode}`);
    localStorage.setItem('lan_chat_device_mode', mode);

    if (mode === 'phone') {
      deviceModeBadgeIcon.textContent = '📱';
      deviceModeBadgeText.textContent = 'Phone';
    } else {
      deviceModeBadgeIcon.textContent = '💻';
      deviceModeBadgeText.textContent = 'Laptop';
    }

    if (deviceModal) deviceModal.style.display = 'none';
    if (!currentUser && authModal) {
      authModal.style.display = 'flex';
    }
  }

  btnSelectPhone.addEventListener('click', () => setDeviceMode('phone'));
  btnSelectLaptop.addEventListener('click', () => setDeviceMode('laptop'));
  btnChangeDeviceMode.addEventListener('click', () => {
    deviceModal.style.display = 'flex';
  });

  // Check saved device mode or default to modal display
  const savedDeviceMode = localStorage.getItem('lan_chat_device_mode');
  if (savedDeviceMode) {
    setDeviceMode(savedDeviceMode);
  } else {
    deviceModal.style.display = 'flex';
    authModal.style.display = 'none';
  }

  // Theme Switcher Logic
  const btnThemeSwitcher = document.getElementById('btnThemeSwitcher');
  const themeBadgeIcon = document.getElementById('themeBadgeIcon');
  const themes = ['dark', 'light', 'cyberpunk', 'hacker', 'retro'];
  let currentThemeIndex = 0;

  if (btnThemeSwitcher) {
    btnThemeSwitcher.addEventListener('click', () => {
      currentThemeIndex = (currentThemeIndex + 1) % themes.length;
      const theme = themes[currentThemeIndex];
      document.body.classList.remove('theme-dark', 'theme-light', 'theme-cyberpunk', 'theme-hacker', 'theme-retro');
      document.body.classList.add(`theme-${theme}`);

      if (theme === 'light') themeBadgeIcon.textContent = '☀️';
      else if (theme === 'cyberpunk') themeBadgeIcon.textContent = '🌆';
      else if (theme === 'hacker') themeBadgeIcon.textContent = '💻';
      else if (theme === 'retro') themeBadgeIcon.textContent = '📻';
      else themeBadgeIcon.textContent = '🌙';

      showToast(`Switched to ${theme.toUpperCase()} theme`);
    });
  }

  // Custom Status
  const btnCustomStatus = document.getElementById('btnCustomStatus');
  if (btnCustomStatus) {
    btnCustomStatus.addEventListener('click', () => {
      if (!currentUser) return;
      const newStatus = prompt('Set a custom status:', currentUser.customStatus || '');
      if (newStatus !== null) {
        socket.emit('set_custom_status', { status: newStatus }, (res) => {
          if (res.success) {
            currentUser.customStatus = res.customStatus;
            showToast('Custom status updated!');
          }
        });
      }
    });
  }

  // In-Chat Search
  const inputSearchChat = document.getElementById('inputSearchChat');
  if (inputSearchChat) {
    inputSearchChat.addEventListener('input', (e) => {
      const q = e.target.value.toLowerCase().trim();
      document.querySelectorAll('.message-card').forEach(card => {
        if (!q) {
          card.style.display = 'flex';
        } else {
          const txt = card.textContent.toLowerCase();
          card.style.display = txt.includes(q) ? 'flex' : 'none';
        }
      });
    });
  }

  // Localhost Admin Panel Setup
  const btnAdminPanel = document.getElementById('btnAdminPanel');
  const adminModal = document.getElementById('adminModal');
  const btnCloseAdminModal = document.getElementById('btnCloseAdminModal');
  const btnAdminExport = document.getElementById('btnAdminExport');
  const adminImportFile = document.getElementById('adminImportFile');
  const btnAdminReset = document.getElementById('btnAdminReset');

  const isLocalhost = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(window.location.hostname);
  if (isLocalhost && btnAdminPanel) {
    btnAdminPanel.style.display = 'inline-flex';
  }

  if (btnAdminPanel) {
    btnAdminPanel.addEventListener('click', () => {
      adminModal.style.display = 'flex';
    });
  }

  if (btnCloseAdminModal) {
    btnCloseAdminModal.addEventListener('click', () => {
      adminModal.style.display = 'none';
    });
  }

  if (btnAdminExport) {
    btnAdminExport.addEventListener('click', () => {
      window.location.href = '/api/admin/export';
    });
  }

  if (adminImportFile) {
    adminImportFile.addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (!file) return;

      const formData = new FormData();
      formData.append('file', file);

      showToast('Importing server backup JSON...');

      fetch('/api/admin/import', {
        method: 'POST',
        body: formData
      })
        .then(res => res.json())
        .then(data => {
          if (data.success) {
            showToast('Server data imported successfully!');
            setTimeout(() => location.reload(), 1000);
          } else {
            showToast(data.error || 'Import failed', 'error');
          }
        })
        .catch(() => {
          showToast('Failed to upload backup file', 'error');
        });
    });
  }

  if (btnAdminReset) {
    btnAdminReset.addEventListener('click', () => {
      if (confirm('⚠️ ARE YOU SURE? This will permanently DELETE ALL ACCOUNTS, groups, and message history!')) {
        fetch('/api/admin/reset', { method: 'POST' })
          .then(res => res.json())
          .then(data => {
            if (data.success) {
              showToast('All accounts and chats deleted.');
              localStorage.removeItem('lan_chat_username');
              setTimeout(() => location.reload(), 1000);
            } else {
              showToast(data.error || 'Reset failed', 'error');
            }
          })
          .catch(() => {
            showToast('Failed to reset server', 'error');
          });
      }
    });
  }

  socket.on('server_reset', () => {
    showToast('Server accounts and data were reset by localhost admin.', 'error');
    localStorage.removeItem('lan_chat_username');
    setTimeout(() => location.reload(), 1000);
  });

  socket.on('data_imported', () => {
    showToast('Server data imported by localhost admin!');
    setTimeout(() => location.reload(), 1000);
  });

  const lanAddressText = document.getElementById('lanAddressText');
  const btnCopyLanUrl = document.getElementById('btnCopyLanUrl');

  const myAvatar = document.getElementById('myAvatar');
  const myUsernameDisplay = document.getElementById('myUsernameDisplay');
  const myLanIdDisplay = document.getElementById('myLanIdDisplay');
  const btnEditProfile = document.getElementById('btnEditProfile');

  const formQuickGroup = document.getElementById('formQuickGroup');
  const inputGroupLanIds = document.getElementById('inputGroupLanIds');
  const inputGroupName = document.getElementById('inputGroupName');

  const channelsList = document.getElementById('channelsList');
  const groupsList = document.getElementById('groupsList');
  const groupsCount = document.getElementById('groupsCount');
  const usersList = document.getElementById('usersList');
  const onlineCount = document.getElementById('onlineCount');
  const inputFilterUsers = document.getElementById('inputFilterUsers');

  const currentRoomIcon = document.getElementById('currentRoomIcon');
  const currentRoomName = document.getElementById('currentRoomName');
  const currentRoomSubtitle = document.getElementById('currentRoomSubtitle');
  const btnCopyRoomId = document.getElementById('btnCopyRoomId');

  const messagesContainer = document.getElementById('messagesContainer');
  const typingIndicator = document.getElementById('typingIndicator');
  const typingText = document.getElementById('typingText');

  const attachmentDrawer = document.getElementById('attachmentDrawer');
  const previewIcon = document.getElementById('previewIcon');
  const previewFileName = document.getElementById('previewFileName');
  const previewFileSize = document.getElementById('previewFileSize');
  const btnRemoveAttachment = document.getElementById('btnRemoveAttachment');

  const messageForm = document.getElementById('messageForm');
  const messageInput = document.getElementById('messageInput');
  const fileInput = document.getElementById('fileInput');
  const btnAttachFile = document.getElementById('btnAttachFile');
  const btnVoiceRecord = document.getElementById('btnVoiceRecord');

  const imageModal = document.getElementById('imageModal');
  const lightboxImage = document.getElementById('lightboxImage');
  const lightboxCaption = document.getElementById('lightboxCaption');
  const lightboxDownloadBtn = document.getElementById('lightboxDownloadBtn');
  const btnCloseLightbox = document.getElementById('btnCloseLightbox');

  const toastContainer = document.getElementById('toastContainer');

  // Fetch LAN info on load
  fetch('/api/lan-info')
    .then(res => res.json())
    .then(data => {
      const portStr = data.port === 80 ? '' : `:${data.port}`;
      const urlStr = `http://${data.primaryIp}${portStr}`;
      lanAddressText.textContent = urlStr;
    })
    .catch(() => {
      lanAddressText.textContent = `http://${window.location.host}`;
    });

  // Copy LAN Host URL
  btnCopyLanUrl.addEventListener('click', () => {
    const textToCopy = lanAddressText.textContent;
    navigator.clipboard.writeText(textToCopy).then(() => {
      showToast('LAN Host URL copied to clipboard!');
    }).catch(() => {
      showToast('Failed to copy LAN URL', 'error');
    });
  });

  // Auth Tab Switching
  tabLoginBtn.addEventListener('click', () => {
    tabLoginBtn.classList.add('active');
    tabRegisterBtn.classList.remove('active');
    formLogin.style.display = 'flex';
    formRegister.style.display = 'none';
  });

  tabRegisterBtn.addEventListener('click', () => {
    tabRegisterBtn.classList.add('active');
    tabLoginBtn.classList.remove('active');
    formRegister.style.display = 'flex';
    formLogin.style.display = 'none';
  });

  // Check Local Storage for saved credentials
  const savedUser = localStorage.getItem('lan_chat_username');
  if (savedUser) {
    loginUsername.value = savedUser;
  }

  function handleAuthSuccess(user, groups) {
    currentUser = user;
    userGroups = groups || [];

    // Save to local storage for persistent login experience
    localStorage.setItem('lan_chat_username', currentUser.username);

    myAvatar.textContent = currentUser.username.charAt(0).toUpperCase();
    myAvatar.style.backgroundColor = currentUser.color;
    myUsernameDisplay.textContent = currentUser.username;
    myLanIdDisplay.textContent = currentUser.lanId;

    authModal.style.display = 'none';
    showToast(`Welcome back, ${currentUser.username}! (${currentUser.lanId})`);

    renderGroupsList();
    switchRoom('general', 'general', 'channel');
  }

  // Submit Login Form
  formLogin.addEventListener('submit', (e) => {
    e.preventDefault();
    const username = loginUsername.value.trim();
    const password = loginPassword.value;

    if (!username || !password) return;

    socket.emit('user_login', { username, password }, (response) => {
      if (response.success) {
        loginPassword.value = '';
        handleAuthSuccess(response.user, response.groups);
      } else {
        showToast(response.error || 'Login failed', 'error');
      }
    });
  });

  // Submit Register Form
  formRegister.addEventListener('submit', (e) => {
    e.preventDefault();
    const username = regUsername.value.trim();
    const password = regPassword.value;
    const lanId = regLanId.value.trim().toUpperCase();

    if (!username || !password) return;

    socket.emit('user_register', { username, password, lanId }, (response) => {
      if (response.success) {
        regPassword.value = '';
        handleAuthSuccess(response.user, response.groups);
      } else {
        showToast(response.error || 'Registration failed', 'error');
      }
    });
  });

  // Logout Button
  btnLogout.addEventListener('click', () => {
    if (confirm('Are you sure you want to log out?')) {
      currentUser = null;
      authModal.style.display = 'flex';
      showToast('Logged out successfully.');
    }
  });

  // Mobile Menu Toggle
  btnMobileMenu.addEventListener('click', () => {
    if (sidebar) {
      sidebar.classList.toggle('mobile-open');
    }
  });

  // PROFILE EDIT MODAL LOGIC
  const profileEditModal = document.getElementById('profileEditModal');
  const formEditProfile = document.getElementById('formEditProfile');
  const editDisplayName = document.getElementById('editDisplayName');
  const editLanId = document.getElementById('editLanId');
  const editPassword = document.getElementById('editPassword');
  const btnCloseProfileModal = document.getElementById('btnCloseProfileModal');

  btnEditProfile.addEventListener('click', () => {
    if (!currentUser) return;
    editDisplayName.value = currentUser.username;
    editLanId.value = currentUser.lanId;
    editPassword.value = '';
    profileEditModal.style.display = 'flex';
  });

  btnCloseProfileModal.addEventListener('click', () => {
    profileEditModal.style.display = 'none';
  });

  formEditProfile.addEventListener('submit', (e) => {
    e.preventDefault();
    const payload = {
      username: editDisplayName.value.trim(),
      lanId: editLanId.value.trim().toUpperCase(),
      password: editPassword.value
    };

    socket.emit('update_profile', payload, (res) => {
      if (res.success) {
        currentUser = res.user;
        myAvatar.textContent = currentUser.username.charAt(0).toUpperCase();
        myAvatar.style.backgroundColor = currentUser.color;
        myUsernameDisplay.textContent = currentUser.username;
        myLanIdDisplay.textContent = currentUser.lanId;
        profileEditModal.style.display = 'none';
        showToast('Profile updated successfully!');
      } else {
        showToast(res.error || 'Profile update failed', 'error');
      }
    });
  });

  socket.on('profile_updated', ({ oldLanId, account }) => {
    if (currentUser && (currentUser.lanId === oldLanId || currentUser.lanId === account.lanId)) {
      currentUser.username = account.username;
      currentUser.lanId = account.lanId;
      currentUser.color = account.color;
      myAvatar.textContent = currentUser.username.charAt(0).toUpperCase();
      myAvatar.style.backgroundColor = currentUser.color;
      myUsernameDisplay.textContent = currentUser.username;
      myLanIdDisplay.textContent = currentUser.lanId;
    }
  });

  // CREATE GROUP MODAL LOGIC
  const btnOpenGroupModal = document.getElementById('btnOpenGroupModal');
  const createGroupModal = document.getElementById('createGroupModal');
  const formCreateGroupModal = document.getElementById('formCreateGroupModal');
  const modalGroupName = document.getElementById('modalGroupName');
  const groupUserPicker = document.getElementById('groupUserPicker');
  const modalDisallowedFiles = document.getElementById('modalDisallowedFiles');
  const btnCloseCreateGroupModal = document.getElementById('btnCloseCreateGroupModal');

  if (btnOpenGroupModal) {
    btnOpenGroupModal.addEventListener('click', () => {
      renderUserPicker();
      modalGroupName.value = '';
      modalDisallowedFiles.value = '';
      createGroupModal.style.display = 'flex';
    });
  }

  if (btnCloseCreateGroupModal) {
    btnCloseCreateGroupModal.addEventListener('click', () => {
      createGroupModal.style.display = 'none';
    });
  }

  function renderUserPicker() {
    groupUserPicker.innerHTML = '';
    const otherUsers = allUsers.filter(u => currentUser && u.lanId !== currentUser.lanId);

    if (otherUsers.length === 0) {
      groupUserPicker.innerHTML = '<span style="font-size:0.8rem; color:var(--text-muted); p-2">No other LAN users connected yet.</span>';
      return;
    }

    otherUsers.forEach(u => {
      const lbl = document.createElement('label');
      lbl.className = 'user-picker-item';
      lbl.innerHTML = `
        <input type="checkbox" value="${u.lanId}" />
        <span class="user-item-name">${escapeHtml(u.username)} (${u.lanId})</span>
      `;
      groupUserPicker.appendChild(lbl);
    });
  }

  formCreateGroupModal.addEventListener('submit', (e) => {
    e.preventDefault();
    const checkboxes = groupUserPicker.querySelectorAll('input[type="checkbox"]:checked');
    const selectedLanIds = Array.from(checkboxes).map(cb => cb.value);

    if (currentUser && !selectedLanIds.includes(currentUser.lanId)) {
      selectedLanIds.push(currentUser.lanId);
    }

    if (selectedLanIds.length < 2) {
      showToast('Select at least one other member for the group!', 'error');
      return;
    }

    const groupName = modalGroupName.value.trim();
    const disallowed = modalDisallowedFiles.value.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);

    socket.emit('create_group', {
      lanIdsInput: selectedLanIds,
      groupName,
      disallowedFileTypes: disallowed
    }, (res) => {
      if (res.success) {
        createGroupModal.style.display = 'none';
        const grp = res.group;
        if (!userGroups.some(g => g.id === grp.id)) {
          userGroups.push(grp);
        }
        renderGroupsList();
        switchRoom(grp.id, grp.name, 'group');
        showToast(`Created group: ${grp.name}`);
      } else {
        showToast(res.error || 'Failed to create group', 'error');
      }
    });
  });

  // GROUP SETTINGS MODAL LOGIC
  const btnGroupSettings = document.getElementById('btnGroupSettings');
  const groupSettingsModal = document.getElementById('groupSettingsModal');
  const btnCloseGroupSettingsModal = document.getElementById('btnCloseGroupSettingsModal');
  const formRenameGroup = document.getElementById('formRenameGroup');
  const settingsGroupName = document.getElementById('settingsGroupName');
  const formAddGroupMembers = document.getElementById('formAddGroupMembers');
  const inputAddMemberLanId = document.getElementById('inputAddMemberLanId');
  const settingsMemberList = document.getElementById('settingsMemberList');
  const formGroupRestrictions = document.getElementById('formGroupRestrictions');
  const settingsDisallowedFiles = document.getElementById('settingsDisallowedFiles');
  const groupDeleteContainer = document.getElementById('groupDeleteContainer');
  const btnDeleteGroup = document.getElementById('btnDeleteGroup');
  const btnLeaveGroup = document.getElementById('btnLeaveGroup');

  if (btnGroupSettings) {
    btnGroupSettings.addEventListener('click', openGroupSettings);
  }

  if (btnCloseGroupSettingsModal) {
    btnCloseGroupSettingsModal.addEventListener('click', () => {
      groupSettingsModal.style.display = 'none';
    });
  }

  function openGroupSettings() {
    if (!activeRoomId.startsWith('group_')) return;
    const grp = userGroups.find(g => g.id === activeRoomId);
    if (!grp) return;

    settingsGroupName.value = grp.name;
    settingsDisallowedFiles.value = (grp.disallowedFileTypes || []).join(', ');

    const isOwner = currentUser && grp.createdBy === currentUser.lanId;
    if (groupDeleteContainer) {
      groupDeleteContainer.style.display = isOwner ? 'block' : 'none';
    }

    if (btnLeaveGroup) {
      btnLeaveGroup.style.display = isOwner ? 'none' : 'block';
    }

    renderSettingsMemberList(grp);
    groupSettingsModal.style.display = 'flex';
  }

  function renderSettingsMemberList(grp) {
    settingsMemberList.innerHTML = '';
    const isOwner = currentUser && grp.createdBy === currentUser.lanId;
    const isAdmin = isOwner || (grp.admins && grp.admins.includes(currentUser?.lanId));

    grp.members.forEach(mId => {
      const u = allUsers.find(x => x.lanId === mId) || { username: mId, lanId: mId };
      const mOwner = (mId === grp.createdBy);
      const mAdmin = !mOwner && grp.admins && grp.admins.includes(mId);

      const li = document.createElement('li');
      li.className = 'settings-member-item';

      let actionsHtml = '';
      if (isAdmin && mId !== currentUser.lanId) {
        if (isOwner) {
          if (!mOwner) {
            if (mAdmin) {
              actionsHtml += `<button class="btn-secondary btn-sm" onclick="groupAction('revoke_admin', '${mId}')">Revoke Admin</button>`;
            } else {
              actionsHtml += `<button class="btn-secondary btn-sm" onclick="groupAction('grant_admin', '${mId}')">Make Admin</button>`;
            }
            actionsHtml += `<button class="btn-secondary btn-sm" onclick="groupAction('transfer_ownership', '${mId}')">Make Owner</button>`;
          }
        }
        if (!mOwner) {
          actionsHtml += `<button class="btn-secondary btn-sm text-danger" onclick="groupAction('remove_member', '${mId}')">Remove</button>`;
        }
      }

      li.innerHTML = `
        <div class="settings-member-info">
          <span>${escapeHtml(u.username)} (${mId})</span>
          ${mOwner ? '<span class="role-badge owner">Owner</span>' : ''}
          ${mAdmin ? '<span class="role-badge admin">Admin</span>' : ''}
        </div>
        <div style="display:flex; gap:6px;">${actionsHtml}</div>
      `;
      settingsMemberList.appendChild(li);
    });
  }

  window.groupAction = function(action, targetLanId) {
    socket.emit('manage_group', {
      groupId: activeRoomId,
      action,
      targetLanId
    }, (res) => {
      if (res.success) {
        showToast('Group updated successfully');
        if (res.group) {
          updateLocalGroup(res.group);
          renderSettingsMemberList(res.group);
        }
      } else {
        showToast(res.error || 'Action failed', 'error');
      }
    });
  };

  formRenameGroup.addEventListener('submit', (e) => {
    e.preventDefault();
    socket.emit('manage_group', {
      groupId: activeRoomId,
      action: 'rename',
      name: settingsGroupName.value.trim()
    }, (res) => {
      if (res.success) {
        showToast('Group renamed!');
        updateLocalGroup(res.group);
        currentRoomName.textContent = res.group.name;
      } else {
        showToast(res.error || 'Rename failed', 'error');
      }
    });
  });

  formAddGroupMembers.addEventListener('submit', (e) => {
    e.preventDefault();
    const newLid = inputAddMemberLanId.value.trim().toUpperCase();
    if (!newLid) return;

    socket.emit('manage_group', {
      groupId: activeRoomId,
      action: 'add_members',
      lanIds: newLid
    }, (res) => {
      if (res.success) {
        inputAddMemberLanId.value = '';
        showToast(`Member ${newLid} added!`);
        updateLocalGroup(res.group);
        renderSettingsMemberList(res.group);
      } else {
        showToast(res.error || 'Failed to add member', 'error');
      }
    });
  });

  formGroupRestrictions.addEventListener('submit', (e) => {
    e.preventDefault();
    const disallowed = settingsDisallowedFiles.value.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);

    socket.emit('manage_group', {
      groupId: activeRoomId,
      action: 'update_restrictions',
      disallowedFileTypes: disallowed
    }, (res) => {
      if (res.success) {
        showToast('File restrictions updated!');
        updateLocalGroup(res.group);
      } else {
        showToast(res.error || 'Update failed', 'error');
      }
    });
  });

  if (btnDeleteGroup) {
    btnDeleteGroup.addEventListener('click', () => {
      if (confirm('⚠️ Are you sure you want to permanently delete this group?')) {
        socket.emit('manage_group', {
          groupId: activeRoomId,
          action: 'delete_group'
        }, (res) => {
          if (res.success) {
            groupSettingsModal.style.display = 'none';
            userGroups = userGroups.filter(g => g.id !== activeRoomId);
            renderGroupsList();
            switchRoom('general', 'general', 'channel');
            showToast('Group deleted.');
          } else {
            showToast(res.error || 'Delete failed', 'error');
          }
        });
      }
    });
  }

  if (btnLeaveGroup) {
    btnLeaveGroup.addEventListener('click', () => {
      if (confirm('Are you sure you want to leave this group?')) {
        socket.emit('manage_group', {
          groupId: activeRoomId,
          action: 'remove_member',
          targetLanId: currentUser.lanId
        }, (res) => {
          if (res.success) {
            groupSettingsModal.style.display = 'none';
            // We get removed via the 'group_removed' event, but we can do it proactively here too
          } else {
            showToast(res.error || 'Failed to leave group', 'error');
          }
        });
      }
    });
  }

  function updateLocalGroup(grp) {
    const idx = userGroups.findIndex(g => g.id === grp.id);
    if (idx !== -1) userGroups[idx] = grp;
    else userGroups.push(grp);
    renderGroupsList();
  }

  socket.on('group_updated', (grp) => {
    updateLocalGroup(grp);
    if (activeRoomId === grp.id) {
      currentRoomName.textContent = grp.name;
    }
  });

  socket.on('group_removed', ({ groupId }) => {
    userGroups = userGroups.filter(g => g.id !== groupId);
    renderGroupsList();
    if (activeRoomId === groupId) {
      switchRoom('general', 'general', 'channel');
      showToast('You were removed from this group.', 'error');
    }
  });

  socket.on('group_deleted', ({ groupId }) => {
    userGroups = userGroups.filter(g => g.id !== groupId);
    renderGroupsList();
    if (activeRoomId === groupId) {
      switchRoom('general', 'general', 'channel');
      showToast('This group was deleted by the owner.', 'error');
    }
  });

  socket.on('user_banned', ({ reason }) => {
    showToast(reason || 'Access restricted.', 'error');
    localStorage.removeItem('lan_chat_username');
    setTimeout(() => location.reload(), 1500);
  });

  socket.on('message_deleted', ({ roomId, messageId }) => {
    if (roomId === activeRoomId) {
      const msgElem = document.getElementById(`msg-${messageId}`);
      if (msgElem) msgElem.remove();
    }
  });

  // Copy Room Details
  btnCopyRoomId.addEventListener('click', () => {
    if (activeRoomType === 'group') {
      const parts = activeRoomId.replace('group_', '').split('_');
      navigator.clipboard.writeText(parts.join(',')).then(() => {
        showToast('Group LAN IDs copied to clipboard!');
      });
    } else if (activeRoomType === 'dm') {
      const parts = activeRoomId.replace('dm:', '').split('_');
      navigator.clipboard.writeText(parts.join(',')).then(() => {
        showToast('Chat LAN IDs copied to clipboard!');
      });
    } else {
      navigator.clipboard.writeText(window.location.href).then(() => {
        showToast('Channel link copied to clipboard!');
      });
    }
  });

  // Socket Event: Users List Update
  socket.on('users_list', (users) => {
    allUsers = users;
    renderUsersList();
  });

  // Socket Event: Group Added
  socket.on('group_added', (group) => {
    if (!userGroups.some(g => g.id === group.id)) {
      userGroups.push(group);
      renderGroupsList();
      showToast(`Added to group: ${group.name}`);
    }
  });

  // Socket Event: New Message Received
  socket.on('new_message', (msg) => {
    const isOutgoing = currentUser && msg.sender.lanId === currentUser.lanId;

    if (msg.roomId === activeRoomId) {
      appendMessage(msg);
      scrollToBottom();
      if (!isOutgoing && !msg.isSystem) {
        notificationAudio.play().catch(() => {});
      }
    } else {
      // Increment unread count
      unreadCounts[msg.roomId] = (unreadCounts[msg.roomId] || 0) + 1;
      updateUnreadBadges();
      if (!msg.isSystem) {
        showToast(`New message from ${msg.sender.username} in ${getRoomDisplayName(msg.roomId)}`);
        notificationAudio.play().catch(() => {});
        if (Notification.permission === 'granted') {
          new Notification('New Message', {
            body: `${msg.sender.username}: ${msg.content || 'Sent an attachment'}`,
          });
        }
      }
    }
  });

  // Socket Event: Typing updates
  socket.on('user_typing', ({ roomId, user }) => {
    if (roomId === activeRoomId && user.lanId !== currentUser?.lanId) {
      typingText.textContent = `${user.username} (${user.lanId}) is typing...`;
      typingIndicator.classList.add('active');
    }
  });

  socket.on('user_stop_typing', ({ roomId, user }) => {
    if (roomId === activeRoomId) {
      typingIndicator.classList.remove('active');
    }
  });

  // Socket Event: Reaction update
  socket.on('message_reaction_updated', ({ roomId, messageId, reactions }) => {
    if (roomId === activeRoomId) {
      const msgElem = document.getElementById(`msg-${messageId}`);
      if (msgElem) {
        renderReactions(msgElem.querySelector('.msg-reactions'), reactions, messageId);
      }
    }
  });

  // Switch Active Room
  function switchRoom(roomId, roomName, roomType) {
    activeRoomId = roomId;
    activeRoomName = roomName;
    activeRoomType = roomType;

    // Clear unread count
    unreadCounts[roomId] = 0;
    updateUnreadBadges();

    // Update Header
    currentRoomName.textContent = roomName;
    if (roomType === 'channel') {
      currentRoomIcon.textContent = '#';
      currentRoomSubtitle.textContent = 'Public broadcast channel for all connected LAN devices';
      btnGroupSettings.style.display = 'none';
    } else if (roomType === 'group') {
      currentRoomIcon.textContent = '👥';
      const grp = userGroups.find(g => g.id === roomId);
      const members = grp ? grp.members : [];
      currentRoomSubtitle.textContent = `Group Members (${members.length}): ${members.join(', ')}`;
      btnGroupSettings.style.display = 'inline-flex';
    } else if (roomType === 'dm') {
      currentRoomIcon.textContent = '👤';
      btnGroupSettings.style.display = 'none';
      const otherId = roomId.replace('dm:', '').split('_').find(id => id !== currentUser.lanId);
      currentRoomSubtitle.textContent = `1-on-1 Direct Chat with LAN User ${otherId || ''}`;
    }

    // Close mobile sidebar when switching rooms
    if (sidebar) sidebar.classList.remove('mobile-open');

    // Active state in navigation
    document.querySelectorAll('.nav-item, .user-item').forEach(el => el.classList.remove('active'));
    
    if (roomType === 'channel') {
      const chElem = document.querySelector(`.nav-item[data-room-id="${roomId}"]`);
      if (chElem) chElem.classList.add('active');
    } else if (roomType === 'group') {
      const grpElem = document.querySelector(`.nav-item[data-group-id="${roomId}"]`);
      if (grpElem) grpElem.classList.add('active');
    } else if (roomType === 'dm') {
      const targetLanId = roomId.replace('dm:', '').split('_').find(id => id !== currentUser?.lanId);
      const userElem = document.querySelector(`.user-item[data-lan-id="${targetLanId}"]`);
      if (userElem) userElem.classList.add('active');
    }

    // Load History
    messagesContainer.innerHTML = '';
    socket.emit('get_history', roomId, (history) => {
      history.forEach(msg => appendMessage(msg));
      scrollToBottom();
    });
  }

  // Render User Selector List
  function renderUsersList() {
    const filter = inputFilterUsers.value.toLowerCase().trim();
    usersList.innerHTML = '';

    const filtered = allUsers.filter(u => {
      if (!currentUser) return true;
      const matchesFilter = u.username.toLowerCase().includes(filter) || u.lanId.toLowerCase().includes(filter);
      return matchesFilter;
    });

    onlineCount.textContent = allUsers.filter(u => u.online).length;

    filtered.forEach(u => {
      const isSelf = currentUser && u.lanId === currentUser.lanId;
      const li = document.createElement('li');
      li.className = 'user-item';
      li.setAttribute('data-lan-id', u.lanId);

      const dmRoomId = currentUser ? getDmRoomId(currentUser.lanId, u.lanId) : '';
      if (activeRoomId === dmRoomId) {
        li.classList.add('active');
      }

      const customStatusHtml = u.customStatus ? `<span class="user-item-status">💬 ${escapeHtml(u.customStatus)}</span>` : '';

      li.innerHTML = `
        <div class="avatar" style="background-color: ${u.color}; width:28px; height:28px; font-size:0.75rem;">
          ${u.username.charAt(0).toUpperCase()}
        </div>
        <div class="user-item-info">
          <span class="user-item-name">${escapeHtml(u.username)} ${isSelf ? '(You)' : ''}</span>
          <span class="user-item-lan">${u.lanId}</span>
          ${customStatusHtml}
        </div>
        <span class="status-dot ${u.online ? 'pulse' : ''}" style="background-color: ${u.online ? '#10b981' : '#64748b'}"></span>
      `;

      li.addEventListener('click', () => {
        if (!currentUser) return;
        if (isSelf) {
          showToast('Cannot start DM with yourself. Use #general or groups!', 'error');
          return;
        }
        const dmId = getDmRoomId(currentUser.lanId, u.lanId);
        switchRoom(dmId, `@${u.username} (${u.lanId})`, 'dm');
      });

      usersList.appendChild(li);
    });
  }

  inputFilterUsers.addEventListener('input', renderUsersList);

  // Render Groups List
  function renderGroupsList() {
    groupsList.innerHTML = '';
    groupsCount.textContent = userGroups.length;

    userGroups.forEach(grp => {
      const li = document.createElement('li');
      li.className = 'nav-item';
      li.setAttribute('data-group-id', grp.id);
      if (activeRoomId === grp.id) li.classList.add('active');

      const unreadCount = unreadCounts[grp.id] || 0;

      li.innerHTML = `
        <span class="hashtag">👥</span>
        <span class="nav-label">${escapeHtml(grp.name)}</span>
        <span class="unread-badge" style="display:${unreadCount > 0 ? 'inline-block' : 'none'}">${unreadCount}</span>
      `;

      li.addEventListener('click', () => {
        switchRoom(grp.id, grp.name, 'group');
      });

      groupsList.appendChild(li);
    });
  }

  // Update Unread Badges
  function updateUnreadBadges() {
    const generalBadge = document.getElementById('unread-general');
    if (generalBadge) {
      const cnt = unreadCounts['general'] || 0;
      generalBadge.textContent = cnt;
      generalBadge.style.display = cnt > 0 ? 'inline-block' : 'none';
    }
    renderGroupsList();
  }

  // Helper DM Room ID
  function getDmRoomId(lanId1, lanId2) {
    const sorted = [lanId1, lanId2].sort();
    return `dm:${sorted[0]}_${sorted[1]}`;
  }

  // Helper Room Display Name
  function getRoomDisplayName(roomId) {
    if (roomId === 'general') return '#general';
    if (roomId.startsWith('group_')) {
      const g = userGroups.find(group => group.id === roomId);
      return g ? g.name : 'Group Chat';
    }
    if (roomId.startsWith('dm:')) {
      const parts = roomId.replace('dm:', '').split('_');
      const other = parts.find(p => p !== currentUser?.lanId);
      const targetUser = allUsers.find(u => u.lanId === other);
      return targetUser ? `@${targetUser.username}` : `Direct Message (${other})`;
    }
    return roomId;
  }

  // Append Message to UI
  const notificationAudio = new Audio('https://actions.google.com/sounds/v1/alarms/beep_short.ogg');

  function appendMessage(msg) {
    if (msg.isSystem) {
      const div = document.createElement('div');
      div.className = 'message-card system-message';
      div.innerHTML = `<span class="system-badge">${escapeHtml(msg.content)}</span>`;
      messagesContainer.appendChild(div);
      return;
    }

    const isOutgoing = currentUser && msg.sender.lanId === currentUser.lanId;
    const div = document.createElement('div');
    div.className = `message-card ${isOutgoing ? 'outgoing' : ''}`;
    div.id = `msg-${msg.id}`;

    const formattedTime = new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    let attachmentHtml = '';
    if (msg.attachment) {
      const att = msg.attachment;
      if (att.isImage) {
        attachmentHtml = `
          <div class="media-preview-container" onclick="openLightbox('${att.url}', '${escapeHtml(att.originalName)}', '${att.downloadUrl}')">
            <img src="${att.url}" alt="${escapeHtml(att.originalName)}" loading="lazy" />
          </div>
        `;
      } else if (att.isVideo) {
        attachmentHtml = `
          <div class="media-preview-container">
            <video src="${att.url}" controls></video>
          </div>
        `;
      } else if (att.isAudio) {
        attachmentHtml = `
          <div class="media-preview-container">
            <audio src="${att.url}" controls></audio>
          </div>
        `;
      } else {
        const fileIcon = getFileIconEmoji(att.mimeType || '');
        attachmentHtml = `
          <a class="file-download-card" href="${att.downloadUrl}?name=${encodeURIComponent(att.originalName)}" download>
            <span class="file-icon">${fileIcon}</span>
            <div class="file-info-text">
              <span class="file-name">${escapeHtml(att.originalName)}</span>
              <span class="file-size">${formatBytes(att.size)} • Click to Download</span>
            </div>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
              <polyline points="7 10 12 15 17 10"></polyline>
              <line x1="12" y1="15" x2="12" y2="3"></line>
            </svg>
          </a>
        `;
      }
    }

    let roleBadgeHtml = '';
    if (msg.sender.roleTag) {
      const cls = msg.sender.roleTag.toLowerCase();
      roleBadgeHtml = `<span class="role-badge ${cls}">${msg.sender.roleTag}</span>`;
    }

    let deleteBtnHtml = '';
    const isSender = currentUser && msg.sender.lanId === currentUser.lanId;
    let canDelete = isSender || isLocalhost;
    if (activeRoomType === 'group') {
      const grp = userGroups.find(g => g.id === activeRoomId);
      if (grp && currentUser) {
        if (currentUser.lanId === grp.createdBy || (grp.admins && grp.admins.includes(currentUser.lanId))) {
          canDelete = true;
        }
      }
    }
    if (canDelete) {
      deleteBtnHtml = `
        <button class="msg-delete-btn" onclick="togglePinMessage('${msg.id}')" title="Pin Message">📌</button>
        ${isSender || isLocalhost ? `<button class="msg-delete-btn" onclick="editMessagePrompt('${msg.id}', '${escapeHtml(msg.content)}')">✏️</button>` : ''}
        <button class="msg-delete-btn" onclick="deleteMessage('${msg.id}')" title="Delete Message">🗑️</button>
        ${isLocalhost && !isSender ? `<button class="msg-delete-btn" onclick="adminBanUser('${msg.sender.lanId}')" title="Ban Sender (Admin)">🚫</button>` : ''}
      `;
    }

    const copyBtnHtml = `<button class="msg-delete-btn" onclick="navigator.clipboard.writeText('${escapeHtml(msg.content).replace(/'/g, "\\'")}'); showToast('Message Copied!')" title="Copy Message">📋</button>`;

    div.innerHTML = `
      <div class="avatar" style="background-color: ${msg.sender.color}; width:36px; height:36px;">
        ${msg.sender.username.charAt(0).toUpperCase()}
      </div>
      <div class="msg-content-wrapper">
        <div class="msg-header">
          <span class="msg-sender" style="color: ${msg.sender.color}">${escapeHtml(msg.sender.username)}</span>
          ${roleBadgeHtml}
          <span class="msg-lan-tag">${msg.sender.lanId}</span>
          <span class="msg-timestamp">${formattedTime}</span>
          ${copyBtnHtml}
          ${deleteBtnHtml}
        </div>
        <div class="msg-bubble">
          ${msg.content ? parseMarkdown(msg.content) : ''}
          ${attachmentHtml}
        </div>
        <div class="msg-reactions"></div>
      </div>
    `;

    renderReactions(div.querySelector('.msg-reactions'), msg.reactions || {}, msg.id);
    messagesContainer.appendChild(div);
  }

  // Render Reactions
  function renderReactions(container, reactions, messageId) {
    container.innerHTML = '';
    const emojis = ['👍', '❤️', '🔥', '🎉'];

    emojis.forEach(emoji => {
      const usersReacted = reactions[emoji] || [];
      const count = usersReacted.length;
      const isReacted = currentUser && usersReacted.includes(currentUser.lanId);

      const pill = document.createElement('span');
      pill.className = `reaction-pill ${isReacted ? 'reacted' : ''}`;
      pill.innerHTML = `${emoji} ${count > 0 ? count : ''}`;
      pill.title = usersReacted.join(', ');

      pill.addEventListener('click', () => {
        socket.emit('add_reaction', { roomId: activeRoomId, messageId, emoji });
      });

      container.appendChild(pill);
    });
  }

  // Message Form Submit
  messageForm.addEventListener('submit', (e) => {
    e.preventDefault();
    let content = messageInput.value.trim();

    if (!content && !pendingAttachment) return;

    // Handle Slash Commands
    if (content.startsWith('/')) {
      const parts = content.split(' ');
      const command = parts[0].toLowerCase();

      if (command === '/clear') {
        messagesContainer.innerHTML = '';
        messageInput.value = '';
        showToast('Chat cleared locally.');
        return;
      } else if (command === '/shrug') {
        content = parts.slice(1).join(' ') + ' ¯\\_(ツ)_/¯';
      } else if (command === '/roll') {
        const result = Math.floor(Math.random() * 100) + 1;
        content = `*rolls a ${result} (1-100)*`;
      } else if (command === '/flip') {
        const result = Math.random() > 0.5 ? 'Heads' : 'Tails';
        content = `*flips a coin: ${result}*`;
      }
    }

    socket.emit('send_message', {
      roomId: activeRoomId,
      content,
      attachment: pendingAttachment
    }, (res) => {
      if (res.success) {
        messageInput.value = '';
        clearAttachment();
        stopTyping();
      } else {
        showToast(res.error || 'Failed to send message', 'error');
      }
    });
  });

  // Typing Indicator Logic
  messageInput.addEventListener('input', () => {
    if (!isTyping) {
      isTyping = true;
      socket.emit('typing_start', { roomId: activeRoomId });
    }
    clearTimeout(typingTimeout);
    typingTimeout = setTimeout(stopTyping, 2000);
  });

  function stopTyping() {
    if (isTyping) {
      isTyping = false;
      socket.emit('typing_stop', { roomId: activeRoomId });
    }
  }

  // Emoji Picker Logic
  const btnEmojiPicker = document.getElementById('btnEmojiPicker');
  const emojiPickerPopup = document.getElementById('emojiPickerPopup');
  const emojiGrid = document.getElementById('emojiGrid');
  const commonEmojis = ['😀','😃','😄','😁','😆','😅','😂','🤣','🥲','☺️','😊','😇','🙂','🙃','😉','😌','😍','🥰','😘','😗','😙','😚','😋','😛','😝','😜','🤪','🤨','🧐','🤓','😎','🥸','🤩','🥳','😏','😒','😞','😔','😟','😕','🙁','☹️','😣','😖','😫','😩','🥺','😢','😭','😤','😠','😡','🤬','🤯','😳','🥵','🥶','😱','😨','😰','😥','😓','🤗','🤔','🤭','🤫','🤥','😶','😐','😑','😬','🙄','😯','😦','😧','😮','😲','🥱','😴','🤤','😪','😵','🤐','🥴','🤢','🤮','🤧','😷','🤒','🤕','🤑','🤠','😈','👿','👹','👺','🤡','💩','👻','💀','☠️','👽','👾','🤖','🎃','😺','😸','😹','😻','😼','😽','🙀','😿','😾'];

  if (btnEmojiPicker) {
    btnEmojiPicker.addEventListener('click', () => {
      if (emojiPickerPopup.style.display === 'none') {
        emojiGrid.innerHTML = '';
        commonEmojis.forEach(emoji => {
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'emoji-btn';
          btn.textContent = emoji;
          btn.addEventListener('click', () => {
            messageInput.value += emoji;
            messageInput.focus();
            emojiPickerPopup.style.display = 'none';
          });
          emojiGrid.appendChild(btn);
        });
        emojiPickerPopup.style.display = 'block';
      } else {
        emojiPickerPopup.style.display = 'none';
      }
    });

    document.addEventListener('click', (e) => {
      if (!btnEmojiPicker.contains(e.target) && !emojiPickerPopup.contains(e.target)) {
        emojiPickerPopup.style.display = 'none';
      }
    });
  }

  // Voice Recording Logic
  let mediaRecorder;
  let audioChunks = [];

  if (btnVoiceRecord) {
    btnVoiceRecord.addEventListener('click', async () => {
      if (mediaRecorder && mediaRecorder.state === 'recording') {
        mediaRecorder.stop();
        btnVoiceRecord.style.color = '';
        btnVoiceRecord.textContent = '🎤';
        return;
      }

      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        mediaRecorder = new MediaRecorder(stream);
        audioChunks = [];

        mediaRecorder.ondataavailable = e => {
          if (e.data.size > 0) audioChunks.push(e.data);
        };

        mediaRecorder.onstop = () => {
          const audioBlob = new Blob(audioChunks, { type: 'audio/webm' });
          const file = new File([audioBlob], `VoiceNote_${Date.now()}.webm`, { type: 'audio/webm' });
          uploadFile(file);
          stream.getTracks().forEach(t => t.stop());
        };

        mediaRecorder.start();
        btnVoiceRecord.style.color = '#ef4444';
        btnVoiceRecord.textContent = '⏹️';
        showToast('Recording voice note...');
      } catch (err) {
        showToast('Microphone access denied', 'error');
      }
    });
  }

  // File Upload Handlers
  btnAttachFile.addEventListener('click', () => fileInput.click());

  fileInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (file) uploadFile(file);
  });

  // Drag and Drop File Support
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
      uploadFile(e.dataTransfer.files[0]);
    }
  });

  function uploadFile(file) {
    const formData = new FormData();
    formData.append('file', file);

    showToast(`Uploading ${file.name}...`);

    fetch('/api/upload', {
      method: 'POST',
      body: formData
    })
      .then(res => res.json())
      .then(data => {
        if (data.success) {
          pendingAttachment = data.file;
          previewIcon.textContent = getFileIconEmoji(data.file.mimeType);
          previewFileName.textContent = data.file.originalName;
          previewFileSize.textContent = formatBytes(data.file.size);
          attachmentDrawer.style.display = 'block';
          showToast('File attached successfully!');
        } else {
          showToast(data.error || 'Upload failed', 'error');
        }
      })
      .catch(err => {
        showToast('File upload failed', 'error');
      });
  }

  btnRemoveAttachment.addEventListener('click', clearAttachment);

  function clearAttachment() {
    pendingAttachment = null;
    fileInput.value = '';
    attachmentDrawer.style.display = 'none';
  }

  // Lightbox Modal
  window.editMessagePrompt = function(messageId, currentContent) {
    const newContent = prompt('Edit message:', currentContent);
    if (newContent && newContent.trim() && newContent !== currentContent) {
      socket.emit('edit_message', { roomId: activeRoomId, messageId, content: newContent.trim() }, (res) => {
        if (res.success) {
          showToast('Message edited');
        } else {
          showToast(res.error || 'Failed to edit message', 'error');
        }
      });
    }
  };

  window.togglePinMessage = function(messageId) {
    socket.emit('toggle_pin_message', { roomId: activeRoomId, messageId }, (res) => {
      if (res.success) {
        showToast(res.isPinned ? 'Message pinned!' : 'Message unpinned');
      } else {
        showToast(res.error || 'Failed to pin message', 'error');
      }
    });
  };

  socket.on('message_edited', ({ roomId, messageId, content }) => {
    if (roomId === activeRoomId) {
      const msgElem = document.getElementById(`msg-${messageId}`);
      if (msgElem) {
        const bubble = msgElem.querySelector('.msg-bubble');
        if (bubble) bubble.textContent = content + ' (edited)';
      }
    }
  });

  socket.on('message_pinned_toggled', ({ roomId, messageId, isPinned }) => {
    if (roomId === activeRoomId) {
      const pinnedBar = document.getElementById('pinnedMessageBar');
      const pinnedText = document.getElementById('pinnedMessageText');
      if (isPinned) {
        pinnedText.textContent = `Pinned Msg #${messageId.slice(-4)}`;
        pinnedBar.style.display = 'flex';
      } else {
        pinnedBar.style.display = 'none';
      }
    }
  });

  window.deleteMessage = function(messageId) {
    socket.emit('delete_message', { roomId: activeRoomId, messageId }, (res) => {
      if (res.success) {
        showToast('Message deleted');
      } else {
        showToast(res.error || 'Failed to delete message', 'error');
      }
    });
  };

  // LOCALHOST ADMIN DASHBOARD LOGIC
  const adminTabHealth = document.getElementById('adminTabHealth');
  const adminTabUsers = document.getElementById('adminTabUsers');
  const adminTabBans = document.getElementById('adminTabBans');
  const adminTabGroups = document.getElementById('adminTabGroups');
  const adminTabAudit = document.getElementById('adminTabAudit');
  const adminTabData = document.getElementById('adminTabData');

  const adminSectionHealth = document.getElementById('adminSectionHealth');
  const adminSectionUsers = document.getElementById('adminSectionUsers');
  const adminSectionBans = document.getElementById('adminSectionBans');
  const adminSectionGroups = document.getElementById('adminSectionGroups');
  const adminSectionAudit = document.getElementById('adminSectionAudit');
  const adminSectionData = document.getElementById('adminSectionData');

  const adminHealthGrid = document.getElementById('adminHealthGrid');
  const adminSocketTable = document.getElementById('adminSocketTable');
  const adminAuditList = document.getElementById('adminAuditList');

  const adminUserSearch = document.getElementById('adminUserSearch');
  const btnAdminRefresh = document.getElementById('btnAdminRefresh');
  const adminUserTable = document.getElementById('adminUserTable');

  const formAdminBan = document.getElementById('formAdminBan');
  const adminBanLanId = document.getElementById('adminBanLanId');
  const adminBanIp = document.getElementById('adminBanIp');
  const adminBannedList = document.getElementById('adminBannedList');

  const adminGroupsList = document.getElementById('adminGroupsList');

  let adminServerState = { users: {}, groups: {}, messages: {}, bannedLanIds: [], bannedIps: [] };

  function setAdminTab(tabName) {
    [adminTabHealth, adminTabUsers, adminTabBans, adminTabGroups, adminTabAudit, adminTabData].forEach(t => t && t.classList.remove('active'));
    [adminSectionHealth, adminSectionUsers, adminSectionBans, adminSectionGroups, adminSectionAudit, adminSectionData].forEach(s => s && (s.style.display = 'none'));

    if (tabName === 'health') {
      if (adminTabHealth) adminTabHealth.classList.add('active');
      if (adminSectionHealth) adminSectionHealth.style.display = 'block';
    } else if (tabName === 'users') {
      if (adminTabUsers) adminTabUsers.classList.add('active');
      if (adminSectionUsers) adminSectionUsers.style.display = 'block';
    } else if (tabName === 'bans') {
      if (adminTabBans) adminTabBans.classList.add('active');
      if (adminSectionBans) adminSectionBans.style.display = 'block';
    } else if (tabName === 'groups') {
      if (adminTabGroups) adminTabGroups.classList.add('active');
      if (adminSectionGroups) adminSectionGroups.style.display = 'block';
    } else if (tabName === 'audit') {
      if (adminTabAudit) adminTabAudit.classList.add('active');
      if (adminSectionAudit) adminSectionAudit.style.display = 'block';
    } else if (tabName === 'data') {
      if (adminTabData) adminTabData.classList.add('active');
      if (adminSectionData) adminSectionData.style.display = 'block';
    }
  }

  if (adminTabHealth) adminTabHealth.addEventListener('click', () => setAdminTab('health'));
  if (adminTabUsers) adminTabUsers.addEventListener('click', () => setAdminTab('users'));
  if (adminTabBans) adminTabBans.addEventListener('click', () => setAdminTab('bans'));
  if (adminTabGroups) adminTabGroups.addEventListener('click', () => setAdminTab('groups'));
  if (adminTabAudit) adminTabAudit.addEventListener('click', () => setAdminTab('audit'));
  if (adminTabData) adminTabData.addEventListener('click', () => setAdminTab('data'));

  function fetchAdminState() {
    fetch('/api/admin/state')
      .then(res => res.json())
      .then(data => {
        adminServerState = data;
        renderAdminUsers();
        renderAdminBans();
        renderAdminGroups();
        renderAdminHealth();
        renderAdminAudit();
      })
      .catch(() => showToast('Failed to fetch admin state', 'error'));
  }

  function renderAdminHealth() {
    if (!adminHealthGrid || !adminServerState.health) return;
    const h = adminServerState.health;
    adminHealthGrid.innerHTML = `
      <div class="admin-health-stat">
        <h5>Active Sockets</h5>
        <span>${h.activeConnections || 0}</span>
      </div>
      <div class="admin-health-stat">
        <h5>Registered Users</h5>
        <span>${h.registeredUsers || 0}</span>
      </div>
      <div class="admin-health-stat">
        <h5>Total Groups</h5>
        <span>${h.totalGroups || 0}</span>
      </div>
    `;

    if (adminSocketTable) {
      adminSocketTable.innerHTML = '';
      (adminServerState.activeSockets || []).forEach(sock => {
        const row = document.createElement('div');
        row.className = 'admin-row';
        row.innerHTML = `
          <div>
            <strong>${escapeHtml(sock.username || 'Unknown')}</strong>
            <span style="font-family:var(--font-mono); font-size:0.75rem; color:var(--text-muted); margin-left:6px;">${sock.lanId || 'No LAN ID'}</span>
          </div>
          <span style="font-size:0.75rem; color: ${sock.online ? '#10b981' : '#64748b'}">${sock.online ? 'Online' : 'Offline'}</span>
        `;
        adminSocketTable.appendChild(row);
      });
      if (!adminServerState.activeSockets || adminServerState.activeSockets.length === 0) {
        adminSocketTable.innerHTML = '<div class="admin-row"><span style="color:var(--text-muted)">No active sockets found</span></div>';
      }
    }
  }

  function renderAdminAudit() {
    if (!adminAuditList || !adminServerState.auditLogs) return;
    adminAuditList.innerHTML = '';

    const logs = adminServerState.auditLogs;
    if (logs.length === 0) {
      adminAuditList.innerHTML = '<div class="admin-row"><span style="color:var(--text-muted)">No audit logs available</span></div>';
      return;
    }

    logs.forEach(log => {
      const row = document.createElement('div');
      row.className = 'admin-row';
      const timeStr = new Date(log.timestamp).toLocaleString();
      row.innerHTML = `
        <div style="display:flex; flex-direction:column; gap:2px;">
          <strong>[${escapeHtml(log.action)}] ${escapeHtml(log.target)}</strong>
          <span style="font-size:0.75rem; color:var(--text-muted);">${escapeHtml(log.details || '')}</span>
        </div>
        <span style="font-size:0.7rem; color:var(--text-dim);">${timeStr}</span>
      `;
      adminAuditList.appendChild(row);
    });
  }

  if (btnAdminPanel) {
    btnAdminPanel.addEventListener('click', () => {
      fetchAdminState();
    });
  }

  if (btnAdminRefresh) {
    btnAdminRefresh.addEventListener('click', fetchAdminState);
  }

  function renderAdminUsers() {
    if (!adminUserTable) return;
    const filter = (adminUserSearch?.value || '').toLowerCase().trim();
    adminUserTable.innerHTML = '';

    const usersArr = Object.values(adminServerState.users || {});
    const filtered = usersArr.filter(u => u.username.toLowerCase().includes(filter) || u.lanId.toLowerCase().includes(filter));

    if (filtered.length === 0) {
      adminUserTable.innerHTML = '<div class="admin-row"><span style="color:var(--text-muted)">No users found</span></div>';
      return;
    }

    filtered.forEach(u => {
      const row = document.createElement('div');
      row.className = 'admin-row';
      row.innerHTML = `
        <div>
          <strong>${escapeHtml(u.username)}</strong>
          <span style="font-family:var(--font-mono); font-size:0.75rem; color:var(--accent); margin-left:6px;">${u.lanId}</span>
        </div>
        <div style="display:flex; gap:6px;">
          <button class="btn-secondary btn-sm" onclick="adminEditUserPrompt('${u.lanId}', '${escapeHtml(u.username)}')">Edit</button>
          <button class="btn-secondary btn-sm text-danger" onclick="adminBanUser('${u.lanId}')">Ban</button>
          <button class="btn-secondary btn-sm text-danger" onclick="adminDeleteUser('${u.lanId}')">Delete</button>
        </div>
      `;
      adminUserTable.appendChild(row);
    });
  }

  if (adminUserSearch) {
    adminUserSearch.addEventListener('input', renderAdminUsers);
  }

  window.adminEditUserPrompt = function(targetLanId, currentUsername) {
    const newName = prompt('New Username for ' + targetLanId + ':', currentUsername);
    if (newName === null) return;
    const newLanId = prompt('New LAN ID for ' + targetLanId + ' (Format LANXXXX):', targetLanId);
    if (newLanId === null) return;

    fetch('/api/admin/edit-user', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        targetLanId,
        username: newName.trim(),
        lanId: newLanId.trim().toUpperCase()
      })
    })
      .then(res => res.json())
      .then(data => {
        if (data.success) {
          showToast('User updated by Admin!');
          fetchAdminState();
        } else {
          showToast(data.error || 'Update failed', 'error');
        }
      });
  };

  window.adminBanUser = function(targetLanId) {
    if (confirm(`Ban LAN ID ${targetLanId}?`)) {
      fetch('/api/admin/ban', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lanId: targetLanId })
      })
        .then(res => res.json())
        .then(data => {
          showToast(`Banned LAN ID ${targetLanId}`);
          fetchAdminState();
        });
    }
  };

  window.adminDeleteUser = function(targetLanId) {
    if (confirm(`Delete account for LAN ID ${targetLanId}?`)) {
      fetch('/api/admin/delete-user', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetLanId })
      })
        .then(res => res.json())
        .then(data => {
          showToast(`Account ${targetLanId} deleted`);
          fetchAdminState();
        });
    }
  };

  function renderAdminBans() {
    if (!adminBannedList) return;
    adminBannedList.innerHTML = '';

    const bannedLans = adminServerState.bannedLanIds || [];
    const bannedIps = adminServerState.bannedIps || [];

    if (bannedLans.length === 0 && bannedIps.length === 0) {
      adminBannedList.innerHTML = '<div style="font-size:0.8rem; color:var(--text-muted); padding:10px;">No banned LAN IDs or IPs.</div>';
      return;
    }

    bannedLans.forEach(lid => {
      const row = document.createElement('div');
      row.className = 'admin-row';
      row.innerHTML = `
        <span>🚫 Banned LAN ID: <strong>${lid}</strong></span>
        <button class="btn-secondary btn-sm" onclick="adminUnban('${lid}', '')">Unban</button>
      `;
      adminBannedList.appendChild(row);
    });

    bannedIps.forEach(ip => {
      const row = document.createElement('div');
      row.className = 'admin-row';
      row.innerHTML = `
        <span>🚫 Banned IP: <strong>${ip}</strong></span>
        <button class="btn-secondary btn-sm" onclick="adminUnban('', '${ip}')">Unban</button>
      `;
      adminBannedList.appendChild(row);
    });
  }

  if (formAdminBan) {
    formAdminBan.addEventListener('submit', (e) => {
      e.preventDefault();
      const lanId = adminBanLanId.value.trim().toUpperCase();
      const ip = adminBanIp.value.trim();

      fetch('/api/admin/ban', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lanId, ip })
      })
        .then(res => res.json())
        .then(data => {
          showToast('Ban applied');
          adminBanLanId.value = '';
          adminBanIp.value = '';
          fetchAdminState();
        });
    });
  }

  window.adminUnban = function(lanId, ip) {
    fetch('/api/admin/unban', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lanId, ip })
    })
      .then(res => res.json())
      .then(() => {
        showToast('Unbanned successfully');
        fetchAdminState();
      });
  };

  function renderAdminGroups() {
    if (!adminGroupsList) return;
    adminGroupsList.innerHTML = '';

    const grps = Object.values(adminServerState.groups || {});
    if (grps.length === 0) {
      adminGroupsList.innerHTML = '<div class="admin-row"><span style="color:var(--text-muted)">No active groups</span></div>';
      return;
    }

    grps.forEach(g => {
      const row = document.createElement('div');
      row.className = 'admin-row';
      row.innerHTML = `
        <div>
          <strong>${escapeHtml(g.name)}</strong>
          <span style="font-size:0.75rem; color:var(--text-muted); margin-left:6px;">Owner: ${g.createdBy} (${g.members.length} members)</span>
        </div>
        <button class="btn-secondary btn-sm text-danger" onclick="adminOverrideDeleteGroup('${g.id}')">Delete Group</button>
      `;
      adminGroupsList.appendChild(row);
    });
  }

  window.adminOverrideDeleteGroup = function(groupId) {
    if (confirm('Delete this group as Super Admin?')) {
      socket.emit('manage_group', {
        groupId,
        action: 'delete_group'
      }, (res) => {
        showToast('Group deleted by Super Admin');
        fetchAdminState();
      });
    }
  };

  window.openLightbox = function(url, caption, downloadUrl) {
    lightboxImage.src = url;
    lightboxCaption.textContent = caption;
    lightboxDownloadBtn.href = `${downloadUrl}?name=${encodeURIComponent(caption)}`;
    imageModal.style.display = 'flex';
  };

  btnCloseLightbox.addEventListener('click', () => {
    imageModal.style.display = 'none';
  });

  imageModal.addEventListener('click', (e) => {
    if (e.target === imageModal) imageModal.style.display = 'none';
  });

  // Utility Functions
  function scrollToBottom() {
    messagesContainer.scrollTop = messagesContainer.scrollHeight;
  }

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function parseMarkdown(str) {
    let html = escapeHtml(str);

    // Bold
    html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    // Italics
    html = html.replace(/\*([^*]+)\*/g, '<em>$1</em>');
    // Code blocks
    html = html.replace(/`([^`]+)`/g, '<code class="md-code">$1</code>');
    // Strikethrough
    html = html.replace(/~~([^~]+)~~/g, '<del>$1</del>');
    // Blockquote
    if (html.startsWith('&gt; ')) {
      html = `<blockquote class="md-quote">${html.substring(5)}</blockquote>`;
    }

    // Auto-link URLs
    const urlRegex = /(https?:\/\/[^\s]+)/g;
    html = html.replace(urlRegex, '<a href="$1" target="_blank" rel="noopener noreferrer" class="md-link">$1</a>');

    return html;
  }

  function downloadChatExport() {
    socket.emit('get_history', activeRoomId, (history) => {
      let text = `Chat Export - ${activeRoomName}\n`;
      text += `Exported on: ${new Date().toLocaleString()}\n`;
      text += `--------------------------------------------------\n\n`;

      history.forEach(msg => {
        if (msg.isSystem) {
          text += `[SYSTEM] ${msg.content}\n`;
        } else {
          const time = new Date(msg.timestamp).toLocaleString();
          const sender = msg.sender.username;
          let content = msg.content || '';
          if (msg.attachment) content += ` [Attached File: ${msg.attachment.originalName}]`;
          text += `[${time}] ${sender}: ${content}\n`;
        }
      });

      const blob = new Blob([text], { type: 'text/plain' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `Export_${activeRoomId}_${Date.now()}.txt`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      showToast('Chat history exported successfully!');
    });
  }

  // Add Export Button to chat actions
  const exportBtn = document.createElement('button');
  exportBtn.className = 'btn-secondary btn-sm';
  exportBtn.title = 'Export Chat History';
  exportBtn.textContent = '💾 Export Chat';
  exportBtn.addEventListener('click', downloadChatExport);
  const headerActions = document.querySelector('.header-actions');
  if (headerActions) headerActions.insertBefore(exportBtn, document.getElementById('btnCopyRoomId'));

  function formatBytes(bytes) {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  }

  function getFileIconEmoji(mimeType) {
    if (mimeType.startsWith('image/')) return '🖼️';
    if (mimeType.startsWith('video/')) return '🎬';
    if (mimeType.startsWith('audio/')) return '🎵';
    if (mimeType.includes('pdf')) return '📕';
    if (mimeType.includes('zip') || mimeType.includes('tar') || mimeType.includes('rar')) return '📦';
    if (mimeType.includes('word') || mimeType.includes('document')) return '📄';
    return '📁';
  }

  function showToast(message, type = 'info') {
    const toast = document.createElement('div');
    toast.className = 'toast';
    if (type === 'error') toast.style.borderColor = '#ef4444';
    toast.textContent = message;

    toastContainer.appendChild(toast);
    setTimeout(() => {
      toast.style.opacity = '0';
      setTimeout(() => toast.remove(), 200);
    }, 3500);
  }

  // Default Channel click handler
  const generalChannelItem = document.querySelector('.nav-item[data-room-id="general"]');
  if (generalChannelItem) {
    generalChannelItem.addEventListener('click', () => {
      switchRoom('general', 'general', 'channel');
    });
  }
});
