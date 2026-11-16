        // If the page stays blank, this is the first thing to check: the
        // bundled libraries must load before app.js. Show a readable message
        // instead of failing silently.
        var g_pwsafe = null;
        var g_startup_error = null;
        try {
            if (typeof PWSafeDB === 'undefined') {
                g_startup_error = 'MyCrypt could not start: libpwsafejs/pwsafedb.js did not load. ' +
                    'Make sure the libpwsafejs directory was uploaded together with app.js.';
            } else {
                g_pwsafe = new PWSafeDB();
            }
        } catch (e) {
            g_startup_error = 'MyCrypt could not start: ' + e.message;
        }
        var g_passphrase = null;
        var g_filename = null;
        var g_treeview = null;
        var g_folders_only = false;
        var g_saved_path = null;
        // My opinionated policy that different nodes on the displayed
        // tree should not have the same path, 
        // i.e: No identical titles displayed under same group (this only
        // affects the UI, not the .psafe3 file).
        var g_paths_map = null; 
        var g_index_to_unique_path = null;
        var g_unique_path_to_index = null;
        var g_modal_shown = false;

        // CSRF token issued by manager.php, plus state used by the lock logic.
        var g_csrf = null;
        var g_unsaved = false;
        var g_lock_timer = null;
        var g_hidden_at = 0;
        var AUTO_LOCK_MS = 10 * 60 * 1000;  // lock after 10 minutes of inactivity
        var CLIPBOARD_CLEAR_MS = 30000;     // clear copied secrets after 30 seconds

        function gebi(id) {
            return document.getElementById(id);
        }

        // Escape a value before it is placed into HTML. Everything that comes
        // from a .psafe3 file (title, group, username, password, notes, URL,
        // names of files served by manager.php) must go through this.
        function escapeHtml(value) {
            return String(value == null ? '' : value).replace(/[&<>"']/g, function(c) {
                switch (c) {
                    case '&': return '&amp;';
                    case '<': return '&lt;';
                    case '>': return '&gt;';
                    case '"': return '&quot;';
                    case "'": return '&#39;';
                    default: return c;
                }
            });
        }

        // Display a message without interpreting it as HTML.
        function showMessage(id, message) {
            var element = gebi(id);
            if (element) {
                element.textContent = String(message == null ? '' : message);
            }
        }

        // Highlight a raw needle inside a raw value, escaping both.
        function highlightText(raw, needle) {
            raw = String(raw == null ? '' : raw);
            if (!needle) {
                return escapeHtml(raw).replaceAll('\n', '<br />');
            }
            var out = '';
            var pos = 0;
            var idx;
            while ((idx = raw.indexOf(needle, pos)) !== -1) {
                out += escapeHtml(raw.slice(pos, idx));
                out += '<span style="background-color:yellow;">' + escapeHtml(needle) + '</span>';
                pos = idx + needle.length;
            }
            out += escapeHtml(raw.slice(pos));
            return out.replaceAll('\n', '<br />');
        }

        function setZoom100() {
            // Modern browsers (except Firefox)
            document.body.style.zoom = "100%";

            // Firefox
            document.body.style.MozTransform = "scale(1)";
        }
        
        function animateText(element, text, distance, delay) {
            if (typeof(distance) !== 'number') {
                distance = 40;
            }
            if (typeof(delay) !== 'number') {
                delay = 500;
            }

            // Create and style the div element with text
            var floatingDiv = document.createElement('div');
            floatingDiv.textContent = text;
            floatingDiv.style.position = 'absolute';
            floatingDiv.style.transition = `all ${delay / 1000}s ease-in-out`;
            floatingDiv.style.opacity = '1';
            floatingDiv.style.zIndex = 1001;

            // Append to body to get its dimensions
            document.body.appendChild(floatingDiv);

            // Get target element and floatingDiv dimensions
            var rect = element.getBoundingClientRect();
            var divHeight = floatingDiv.offsetHeight;

            // Adjust position so bottom of floatingDiv aligns with top of element
            floatingDiv.style.left = rect.left + 'px';
            floatingDiv.style.top = (rect.top - divHeight) + 'px';

            // Start the animation
            setTimeout(function() {
                floatingDiv.style.top = (rect.top - divHeight - distance) + 'px'; // Move up by distance px from starting position
                floatingDiv.style.opacity = '0'; // Fade out

                // Remove the div after animation
                setTimeout(function() {
                    document.body.removeChild(floatingDiv);
                }, delay); // Use delay parameter for duration
            }, 0);
        }

        function copyToClipboard(text) {
            function copyToClipboardFallback(value) {
                var tempInput = document.createElement("input");
                tempInput.style = "position: absolute; left: -1000px; top: -1000px";
                tempInput.value = value;
                document.body.appendChild(tempInput);
                tempInput.select();
                try {
                    document.execCommand("copy");
                } catch (e) {
                    console.error('Clipboard copy failed');
                }
                document.body.removeChild(tempInput);
            }

            // Remove secrets from the clipboard after a short delay, but only
            // if the clipboard still contains what we put there.
            function scheduleClipboardClear(value) {
                setTimeout(function() {
                    if (!navigator.clipboard || !navigator.clipboard.readText) {
                        return;
                    }
                    navigator.clipboard.readText().then(function(current) {
                        if (current === value) {
                            return navigator.clipboard.writeText('');
                        }
                    }).catch(function() {
                        // Reading the clipboard may be denied; leave it alone.
                    });
                }, CLIPBOARD_CLEAR_MS);
            }

            if (navigator.clipboard && navigator.clipboard.writeText) {
                navigator.clipboard.writeText(text).then(function() {
                    scheduleClipboardClear(text);
                }, function() {
                    copyToClipboardFallback(text);
                    scheduleClipboardClear(text);
                });
                return;
            }
            copyToClipboardFallback(text);
            scheduleClipboardClear(text);
        }

        function daysSince(date) {
            const today = new Date();
            const pastDate = new Date(date);
            const millisecondsPerDay = 24 * 60 * 60 * 1000; // Number of milliseconds in a day
            const elapsedMilliseconds = today - pastDate; // Difference in milliseconds
            const total = parseInt(Math.floor(elapsedMilliseconds / millisecondsPerDay));
            var retval = null
            switch (total) {
                case 0: 
                    retval = 'today';
                    break;
                case 1:
                    retval = 'yesterday';
                    break;
                default: 
                    retval = `${total} days ago`;
                    break;
            }
            return retval;
        }

        function compareTreeNodes(a, b) {
            var ac = a.children.length > 0 ? 1 : 0; 
            var bc = b.children.length > 0 ? 1 : 0; 
            if (ac != bc) {
                return bc - ac; // node or folder
            }

            return b.name.toLowerCase() < a.name.toLowerCase(); // Alphabetical order (case-insensitive)
        }

        function create_progress_bar(id) {
            var obj = {};
            var pcontainer = gebi(id);
            var html = `
                <div id="id_progress_status" style="width:100%; background-color:#ddd; font-family:Arial; font-size:14px;"> 
                    <div id="id_progress_bar" style="width:1%; height:27px; background-color:lightgreen; text-align:center; line-height:25px; color:black;">1%</div> 
                </div> 
            `;
            pcontainer.innerHTML = html;
            var element = gebi("id_progress_bar"); 
            obj.position = function(percent) {
                percent = percent < 0 ? 0 : percent;
                percent = percent > 100 ? 100 : percent;
                element.style.width = percent + '%'; 
                element.innerHTML = percent + '%'; 
            }
            obj.position(0);
            return obj;
        }

        function save_record(pwrec) {
            var now = new Date();
            var modified = false;
            for (var field of ['username', 'password', 'URL', 'notes']) {
                var id = `id_login_val_${field}`;
                var val = gebi(id).value;
                if (val && val !== '') {
                    if (pwrec[field] !== val) {
                        modified = true;
                        pwrec[field] = val;
                        if (field == 'password') {
                            pwrec.passphraseModifyTime = now;
                        }
                    }
                }
            }

            if (modified) {
                pwrec.modifyTime = now;
            }
            hideModal();
        }

        function appendCopyIcon(input_element_id, copy_icon_path) {
            const inputElement = gebi(input_element_id);
            if (inputElement == null) {
                console.warn(`input element is null for id '${input_element_id}'`);
                return;
            }

            // Check if the icon already exists
            var prevSibling = inputElement;
            var nextSibling = inputElement.nextElementSibling;;
            var accumulated_icons_width = 0;
            var margin_left = 3;
            while(nextSibling && nextSibling.nodeName === 'IMG') {
                if (nextSibling.classList.contains("copy-icon")) {
                    return; // Icon already added, no need to create another
                }
                accumulated_icons_width += nextSibling.clientWidth + margin_left + 5;
                prevSibling = nextSibling;
                nextSibling = nextSibling.nextSibling;
            }
            
            inputElement.parentNode.style.visibility = 'hidden';
            const copyIcon = document.createElement("img");
            copyIcon.src = copy_icon_path; // Initial icon (hidden password)
            copyIcon.style.cursor = "pointer"; // Change cursor to a hand
            copyIcon.classList.add("copy-icon"); // Add a custom class for identification
            copyIcon.style.height = (inputElement.clientHeight+5) + 'px';
            copyIcon.style.verticalAlign = 'middle';
            copyIcon.style.marginLeft = `${margin_left}px`;

            copyIcon.onload = function() {
                var reduce_width = accumulated_icons_width + copyIcon.clientWidth + margin_left;
                inputElement.style.width = `calc(95% - ${reduce_width}px)`;
                inputElement.parentNode.style.visibility = '';
            }
            // Add the icon to the right of the input
            prevSibling.insertAdjacentElement("afterend", copyIcon);

            copyIcon.onclick = function () {
                copyToClipboard(inputElement.value);
                animateText(copyIcon, 'Copied', 10, 450);
            };
        }

        function appendPasswordToggler(input_element_id, path_eye, path_eye_slash) {
            var inputElement = gebi(input_element_id);

            if (inputElement == null) {
                console.warn(`input element is null for id '${input_element_id}'`);
                return;
            }

            var prevSibling = inputElement;
            var nextSibling = inputElement.nextElementSibling;
            var accumulated_icons_width = 0;
            var margin_left = 3;

            while(nextSibling && nextSibling.nodeName === 'IMG') {
                // Check if the icon already exists
                if (nextSibling.classList.contains("password-toggle-icon")) {
                    return; // Icon already added, no need to create another
                }
                accumulated_icons_width += nextSibling.clientWidth + margin_left + 5;
                prevSibling = nextSibling;
                nextSibling = nextSibling.nextSibling;
            }

            inputElement.parentNode.style.visibility = 'hidden';

            const toggleIcon = document.createElement("img");
            toggleIcon.src = path_eye; // Initial icon (hidden password)
            toggleIcon.style.cursor = "pointer"; // Change cursor to a hand
            toggleIcon.classList.add("password-toggle-icon"); // Add a custom class for identification
            toggleIcon.style.height = (inputElement.clientHeight+5) + 'px';
            toggleIcon.style.verticalAlign = 'middle';
            toggleIcon.style.marginLeft = `${margin_left}px`;

            toggleIcon.onload = function() {
                var reduce_width = accumulated_icons_width + toggleIcon.clientWidth + margin_left;
                inputElement.style.width = `calc(95% - ${reduce_width}px)`;
                inputElement.parentNode.style.visibility = '';
            }
            // Add the icon to the right of the input

            inputElement.insertAdjacentElement("afterend", toggleIcon);

            // Toggle password visibility when the icon is clicked
            toggleIcon.onclick = function () {
                const type = inputElement.getAttribute("type") === "password" ? "text" : "password";
                // TODO: the entire mess below is because inputElement.setAttribute("type", type)
                //       resets inputElement.style.width to some previous value for some reason
                //       and setting it to the correct value by brute force works only after
                //       a timeout.
                var savewidth = inputElement.style.width;
                var savedisplay = inputElement.style.display;
                inputElement.parentNode.style.visibility = 'hidden';
                inputElement.setAttribute("type", type);
                // Toggle the icon
                this.src = this.src.endsWith(path_eye) ? path_eye_slash : path_eye;
                setTimeout(function() {
                    inputElement.style.width = savewidth;
                    inputElement.style.display = savedisplay;
                    inputElement.parentNode.style.visibility = '';
                }, 50);
            };
        }

        function append_copy_icon(field_id) {
            appendCopyIcon(field_id, "copy.svg");
        }

        function append_password_toggle(passfield_id, copyIcon) {
            if (typeof(copyIcon) !== 'boolean') {
                copyIcon = true;
            }
            appendPasswordToggler(passfield_id, "eye.svg", "eye_off.svg");
            if (copyIcon) {
                append_copy_icon(passfield_id);
            }
        }

        function delLogin(treerec) {
            var path = treerec.data.path;
            remove_and_reload(path)
            update_unsaved_ui(true);
        }

        function makeFirstUpper(str) {
            return str.charAt(0).toUpperCase() + str.slice(1);
        }        

        function renLogin(treerec) {
            var index = treerec.data.index;
            var path = treerec.data.path;
            var pwrec = g_pwsafe.records[index];
            var html = `<table style="width:100%; margin-bottom:6px;">
                <tr>
                    <td>New Name</td>
                    <td><input id="id_ren_login" style="width:95%" value="${escapeHtml(pwrec.title)}"></td>
                </tr>
                </table>
                <button id='id_btn_ren_login'>Save</button>&nbsp;
                <button data-action="close">Cancel</button>
                `;

            showModal(html, {'focus_id':'id_ren_login'});

            gebi(`id_btn_ren_login`).onclick = function() {
                var newname = gebi('id_ren_login').value.replaceAll('.', '\\.');
                pwrec.title = newname;
                var newpath = pwrec.group + "." + pwrec.title; 
                var selNode = reload_and_expand(newpath)
                update_unsaved_ui(true);
                hideModal();
            };
        }

        // View/Edit login values
        function viewLoginValues(treerec, editable) {
            if (typeof(editable) !== 'boolean') {
                editable = false;
            }
            var readonly = editable ? '' : 'readonly';

            var index = treerec.data.index;
            var pwrec = g_pwsafe.records[index]            

            var html = '<table style="width:100%;">';
            for (var field of ['username', 'password', 'URL', 'notes']) {
                var value_container_tag = `<input style='width:95%;' id="id_login_val_${field}" ${readonly}/>`
                if (field === 'notes') {
                    value_container_tag = `<textarea style='width:95%; height:25vh;' id="id_login_val_${field}" ${readonly}></textarea>`
                }
                if (field === 'password') {
                    value_container_tag = `<input type='password' style='width:100%;' id="id_login_val_${field}" ${readonly} />`
                }

                html += `<tr>
                    <td class='field_name'>${makeFirstUpper(field)}</td>
                    <td>${value_container_tag}</td>
                    </tr>`;
            }
            html += '</table>';
            html += '<br />';
            if (editable) {
                html += `<button id='id_btn_save_rec'>Save</button>&nbsp;`
            }
            html += `<button data-action="close">Cancel</button>`;

            showModal(html, {'focus_id':'id_login_val_username'});

            for (var field of ['username', 'password', 'URL', 'notes']) {
                var value = ''
                if (field in pwrec) {
                    value = pwrec[field];
                }
                gebi(`id_login_val_${field}`).value = value;
            }

            append_password_toggle("id_login_val_password");
            append_copy_icon('id_login_val_username');
            append_copy_icon('id_login_val_URL');

            if (editable) {
                gebi(`id_btn_save_rec`).onclick = function() {
                    save_record(pwrec);
                    display_record_data(treerec);
                    update_unsaved_ui(true);                
                };
            }

        }
        
        function showModal(html_content, options) {
            // Create modal elements
            const modal = document.createElement('div');
            modal.id = 'customModal';
            modal.style.position = 'fixed';
            modal.style.top = '50%';
            modal.style.left = '50%';
            modal.style.width = 'min(90%, 800px)';
            modal.style.maxHeight = '90vh';
            modal.style.overflowY = 'auto';
            modal.style.transform = 'translate(-50%, -50%)';
            modal.style.backgroundColor = 'white';
            modal.style.padding = '20px';
            modal.style.boxShadow = '0 5px 15px rgba(0,0,0,0.3)';
            modal.style.zIndex = '1000';
            modal.style.boxSizing = 'border-box';

            const overlay = document.createElement('div');
            overlay.id = 'modalOverlay';
            overlay.style.position = 'fixed';
            overlay.style.top = '0';
            overlay.style.left = '0';
            overlay.style.width = '100%';
            overlay.style.height = '100%';
            overlay.style.backgroundColor = 'rgba(0,0,0,0.5)';
            overlay.style.zIndex = '999';

            // Insert HTML content into modal
            modal.innerHTML = html_content;

            // Append modal and overlay to the body
            document.body.appendChild(modal);
            document.body.appendChild(overlay);

            // Wire up "Cancel"-style buttons without inline event handlers
            // (the Content-Security-Policy forbids inline handlers).
            modal.querySelectorAll('[data-action="close"]').forEach(function(button) {
                button.addEventListener('click', hideModal);
            });

            var focus_id, modal_width;
            if (typeof(options) == 'object') {
                if ('focus_id' in options) {
                    focus_id = options['focus_id'];
                }
                if ('modal_width' in options) {
                    modal_width = options['modal_width'];
                }
            }

            if (typeof(focus_id) == 'string') {
                setTimeout(function() {gebi(focus_id).focus();}, 500)
            }
            if (typeof(modal_width) == 'string') {
                modal.style.width = modal_width;
            }

            // Close modal when overlay is clicked
            overlay.addEventListener('click', hideModal);
            g_modal_shown = true;
        }

        function hideModal() {
            const modal = gebi('customModal');
            const overlay = gebi('modalOverlay');
            if (modal) modal.remove();
            if (overlay) overlay.remove();
            g_modal_shown = false;
        }


        /*
        // Function to show the modal        
        function showModal(html, options) {
            var focus_id, modal_width;
            if (typeof(options) == 'object') {
                if ('focus_id' in options) {
                    focus_id = options['focus_id'];
                }
                if ('modal_width' in options) {
                    modal_width = options['modal_width'];
                }
            }
            const modal_content = gebi("id_modal_content");
            modal_content.innerHTML = html;
            const modal = gebi("id_modal");
            modal.style.display = "block";
            if (typeof(focus_id) == 'string') {
                gebi(focus_id).focus();
            }
            if (typeof(modal_width) == 'string') {
                modal_content.style.width = modal_width;
            }
            
        }

        // Function to hide the modal
        function hideModal() {
            const modal = gebi("id_modal");
            modal.style.display = "none"; // hide modal

            const modal_content = gebi("id_modal_content");
            modal_content.style.width = 'calc(100% - 95px)' // reset modal content width;
            g_modal_shown = false; 
        }

        const modal = gebi("modal");
        */

        function sortTree(nodes) {
            for (const node of nodes) {
                sortTree(node.children);
                node.children.sort((a, b) => {
                    return compareTreeNodes(a, b);
                });
            }
        }

        //------------------------------------------------------------------------------------
        function remove_and_reload(path) {
            var indexes_to_remove = {};
            for (var up in g_unique_path_to_index) {
                if (up === path || up.startsWith(path + '.')) {
                    indexes_to_remove[g_unique_path_to_index[up]] = true;
                }
            }

            g_pwsafe.records = g_pwsafe.records.filter(function(x, index) {
                return !(index in indexes_to_remove);
            });

            var selNode = reload_and_expand(path);
        }

        //------------------------------------------------------------------------------------
        function reload_and_expand(path) {
            build_tree();
            var regex = /(?<!\\)\./g;
            var nodes = path.split(regex)
            while (nodes.length > 0) {
                var node = g_treeview.getNode(path)
                if (node != null) {
                    g_treeview.expandBranchTo(node);
                    g_treeview.clickNode(node)
                    return node;
                }
                nodes.pop();
                path = nodes.join('.')
            }
            return null
        }

        function show_context_menu(info) {
            //console.log('context menu');
            var folder = (info.data.children.length > 0);
            //console.log("context menu, info.data=",info.data);

            var node = g_treeview.getNode(info.data.path);
            g_treeview.expandBranchTo(node);
            g_treeview.clickNode(node);

            if (folder) {
                attach_buttons('id_tree_ctxmenu', {sep:' '}, info, [
                    {id:'id_ctx_addlogin_btn', func:folderAddLogin, text:'Add Login Here'},
                    {id:'id_ctx_addfolder_btn', func:folderAddFolder, text:'Add Folder Here'},
                    {id:'id_ctx_edtfolder_btn', func:folderRename, text:'Rename Folder'},
                    {id:'id_ctx_delfolder_btn', func:folderDelete, text:'Delete Folder'},
                    {id:'id_ctx_mvfolder_btn', func:folderMove,  text:'Move Folder'},
                ], true);
            }
            else {
                attach_buttons('id_tree_ctxmenu', {sep:' '}, info, [
                    {id:'id_ctx_viewlogin_btn', func:function(record) { viewLoginValues(record, false) }, text:'View'},                    
                    {id:'id_ctx_editrecs_btn', func:function(record) {viewLoginValues(record, true)}, text:'Edit'},
                    {id:'id_ctx_rmlogin_btn', func:delLogin, text:'Delete'},
                    {id:'id_ctx_renlogin_btn', func:renLogin, text:'Rename'},
                ], true);
            }

            var contextMenu = gebi('id_tree_ctxmenu');
            var elem = info.target;
            contextMenu.style.top = elem.pageY + "px";
            contextMenu.style.left = elem.pageX + "px";
            contextMenu.style.right = "auto";

            var rect = contextMenu.getBoundingClientRect();
            if (rect.right > window.innerWidth) {
                contextMenu.style.left = "auto";
                contextMenu.style.right = "10px";
            }
            if (rect.bottom > window.innerHeight) {
                contextMenu.style.top = (window.innerHeight - rect.height - 10) + "px";
            }

            // Show the context menu
            contextMenu.style.display = "block";
        }

        function uuid() {
            // Password Safe stores UUIDs as 32 hex characters (no dashes),
            // so generate 16 random bytes and hex-encode them. Use the
            // platform CSPRNG, never Math.random().
            var bytes = new Uint8Array(16);
            if (window.crypto && window.crypto.getRandomValues) {
                window.crypto.getRandomValues(bytes);
            } else {
                throw new Error('No secure random number generator available');
            }
            var result = '';
            for (var i = 0; i < bytes.length; i++) {
                result += ('0' + bytes[i].toString(16)).slice(-2);
            }
            return result;
        }

        function getval(id, defval) {
            var val = null;
            if (typeof(defval) == 'string') {
                val = defval
            }
            var obj = gebi(id);
            return obj ? obj.value : val;
        }

        function rename_pwsafe_groups(groupname, newgroupname) {
            for (var i=0; i<g_pwsafe.records.length; i++) {
                var record = g_pwsafe.records[i];
                if ('group' in record) {
                    if (record.group === groupname || record.group.startsWith(groupname + '.')) {
                        record.group = record.group.replace(groupname, newgroupname)
                    }
                }
            }
        }

        function onDestFolderSelected(treerec) {
            g_folders_only = false;
            var selpath = treerec.data.path;
            var from_folder = g_saved_path.split(/(?<!\\)\./).pop();
            var newfolder = disambiguate_branch(selpath, from_folder);
            var newgroupname = selpath + '.' + newfolder;
            var groupname = g_saved_path;

            rename_pwsafe_groups(groupname, newgroupname);
            var selNode = reload_and_expand(newgroupname);
        }

        function onCancelFolderSelection(treerec) {
            g_folders_only = false;
            var selNode = reload_and_expand(g_saved_path);
        }
       
        function update_unsaved_ui(unsaved) {
            g_unsaved = !!unsaved;
            var rootmenu_img = gebi('id_rootmenu_img');
            var save_file_btn = gebi('id_save_file_btn');
            if (typeof(update_unsaved_ui.rootmenu_img_color) == 'undefined') {
                update_unsaved_ui.rootmenu_img_color = rootmenu_img ? rootmenu_img.style.backgroundColor : '';
                update_unsaved_ui.save_file_btn_color = save_file_btn ? save_file_btn.style.backgroundColor : '';
            }
            if (rootmenu_img && save_file_btn) {
                if (unsaved) {
                    rootmenu_img.style.backgroundColor = '#ff9999';
                    save_file_btn.style.backgroundColor = '#ff9999';
                }
                else {
                    rootmenu_img.style.backgroundColor = update_unsaved_ui.rootmenu_img_color;
                    save_file_btn.style.backgroundColor = update_unsaved_ui.save_file_btn_color;
                }
            }
        }

        function setPassword() {
            var html = `<table style="width:100%; margin-bottom:6px;">
                <tr>
                    <td>New Password</td>
                    <td><input id="id_new_password" type="password" style="width:100%;" value="" autocomplete="new-password" spellcheck="false"></td>
                </tr>
                </table>
                <button id='id_btn_new_password'>Save</button>&nbsp;
                <button data-action="close">Cancel</button>
                `;

            showModal(html, {'focus_id':'id_new_password'});

            append_password_toggle("id_new_password", false);
            gebi(`id_btn_new_password`).onclick = function() {
                var newpass = gebi('id_new_password').value;
                if (newpass === '') {
                    alert('The master password must not be empty.');
                    return;
                }
                g_passphrase = newpass;
                update_unsaved_ui(true);
                hideModal();
            };
        }

        function folderAddLogin(treerec) {
            var path = treerec.data.path;

            var html = '<table style="width:100%">';
            var valtag;
            for (var field of ['title', 'username', 'password', 'URL', 'notes']) {
                switch (field) {
                    case 'password':
                        valtag = `<input type='password' style='width:100%;' id="id_newlogin_val_${field}" autocomplete="new-password" spellcheck="false" />`
                        break;
                    case 'notes':
                        valtag = `<textarea style='resize:none; width:95%;' id="id_newlogin_val_${field}"></textarea>`
                        break;
                    default:
                        valtag = `<input style='width:95%;' id="id_newlogin_val_${field}" />`
                        break;
                }
                html += `<tr>
                    <td class='field_name'>${makeFirstUpper(field)}</td>
                    <td>${valtag}</td>
                    </tr>`;
            }
            html += '</table>';
            html += '<br />';
            html += `<button id='id_btn_save_rec'>Save</button>&nbsp;<button data-action="close">Cancel</button>`;

            showModal(html, {'focus_id':'id_newlogin_val_title'});
            append_password_toggle("id_newlogin_val_password", false);

            gebi(`id_btn_save_rec`).onclick = function() {            
                var now = new Date();

                var title = getval('id_newlogin_val_title', 'No Title');

                var record = {
                    'uuid' : uuid(),
                    'createTime' : now,
                    'notes': getval('id_newlogin_val_notes', ''),
                    'password': getval('id_newlogin_val_password', ''),
                    'title': title,
                    'username': getval('id_newlogin_val_username', ''),
                    'URL': getval('id_newlogin_val_URL', '')
                }

                if (path != '')  {
                    record.group = path;
                }

                g_pwsafe.records.push(record);
                var newpath = (path == '') ? record.title : path + '.' + record.title;
                var selNode = reload_and_expand(newpath)
                update_unsaved_ui(true);
                hideModal();
            }
        }

        function folderAddFolder(treerec) {
            var path = treerec.data.path;

            var html = `<table style="width:100%; margin-bottom:6px;">
                <tr>
                    <td>Folder Name</td>
                    <td><input id="id_new_folder" style="width:95%" value=""></td>
                </tr>
                </table>
                <button id='id_btn_new_folder'>Save</button>&nbsp;
                <button data-action="close">Cancel</button>
                `;

            showModal(html, {'focus_id':'id_new_folder'});

            gebi(`id_btn_new_folder`).onclick = function() {
                var foldername = gebi('id_new_folder').value.replaceAll('.', '\\.');
                var newpath = (path == '') ? foldername : path + '.' + foldername;

                if (!(newpath in g_paths_map)) {
                    // Dummy record for folder placeholder
                    var title = '';
                    var record = {
                        'group': newpath,
                        'title': title // Empty title will cause the leaf `${newpath}.{title}` not to be shown (see buildTreeStruct)
                    }
                    g_pwsafe.records.push(record);
                }

                var selNode = reload_and_expand(newpath)
                hideModal();
            };
        }

        function folderRename(treerec) {
            var path = treerec.data.path; // path is created while building the tree
            var regex = /(?<!\\)\./g;
            var folders = path.split(regex);
            var groupname = folders.join(".");
            var prevname = folders.pop();
            var displayfolderName = prevname.replaceAll('\\.', '.') // get the innermost folder name

            var html = `<table style="width:100%; margin-bottom:6px;">
                <tr>
                    <td>New Name</td>
                    <td><input id="id_ren_folder" style="width:95%" value="${escapeHtml(displayfolderName)}"></td>
                </tr>
                </table>
                <button id='id_btn_ren_folder'>Save</button>&nbsp;
                <button data-action="close">Cancel</button>
                `;

            showModal(html, {'focus_id':'id_ren_folder'});

            gebi(`id_btn_ren_folder`).onclick = function() {
                var newname = gebi('id_ren_folder').value.replaceAll('.', '\\.');
                var parentgroup = folders.join(".");
                var options = {'rmleaf':prevname}
                newname = disambiguate_branch(parentgroup, newname, options);
                folders.push(newname);
                var newgroupname = folders.join(".");
                
                rename_pwsafe_groups(groupname, newgroupname);

                var selNode = reload_and_expand(newgroupname);
                update_unsaved_ui(true);
                hideModal();
            };
        }

        function folderDelete(treerec) {
            var path = treerec.data.path;
            update_unsaved_ui(true);
            remove_and_reload(path)
        }

        function folderMove(treerec) {
            g_saved_path = treerec.data.path;
            g_folders_only = true;
            build_tree();
        }

        function display_folder_data(treerec) {
            var html = `<div class="record-header">
                        ${escapeHtml(treerec.data.name)}<br />
                        <hr /><br /></div>
                        <div id='id_folder_btns'></div>`;

            if (g_folders_only) {
                inrhtml('id_record', html);

                attach_buttons('id_folder_btns', {class:'folder-option', sep:'&nbsp;'}, treerec, [
                    {id:'id_selectfolder_btn', func:onDestFolderSelected, text:'Select this folder'},
                ]);

                return;
            }
                        
            inrhtml('id_record', html);

            attach_buttons('id_folder_btns', {class:'folder-option', sep:'<br />'}, treerec, [
                {id:'id_addlogin_btn', func:folderAddLogin, text:'Add Login Here'},
                {id:'id_addfolder_btn', func:folderAddFolder, text:'Add Folder Here'},
                {id:'id_edtfolder_btn', func:folderRename, text:'Rename Folder'},
                {id:'id_delfolder_btn', func:folderDelete, text:'Delete Folder'},
                {id:'id_mvfolder_btn', func:folderMove,  text:'Move Folder'},
            ]);
        }

        function attach_buttons(id, btnui, treerec, btnlist, hide_after_click) {
            var html = '';
            var cls = 'class' in btnui ? `class='${btnui.class}' ` : '';
            var btnsep = 'sep' in btnui ? btnui.sep : '';
            var hide_on_click = typeof(hide_after_click) != 'boolean' ? false : hide_after_click;
            
            for (var i=0; i<btnlist.length; i++) {
                var btninfo = btnlist[i];
                var btnid = btninfo.id;
                var btntxt = btninfo.text;
                html += `<button id='${btnid}' ${cls}>${btntxt}</button>${btnsep}`;
            }

            inrhtml(id, html);
            for (var i=0; i<btnlist.length; i++) {
                let btninfo = btnlist[i];
                let btnid = btninfo.id;
                let btnfunc = btninfo.func;
                
                gebi(btnid).onclick = function() {
                    // If a menu, hide it prior to executing the function
                    if (hide_on_click) {
                        gebi(id).style.display = 'none';
                    }
                    btnfunc(treerec);
                }
            }
        }

        function display_record_data(treerec) {
            var index = treerec.data.index;
            var pwrec = g_pwsafe.records[index];
            var html = `<div class="record-header">
                        ${escapeHtml(pwrec.title.replaceAll('\\.','.'))} &nbsp;
                        <hr />
                        <div id='id_login_btns'></div>
                        </div>
                        <br />
                        <table id='id_table_record_data' style='width:100%'>`;

            for (var field of ['username', 'password', 'URL']) { // In quick view, don't show 'notes' and other fields
                var value = null
                if (field in pwrec) {
                    value = pwrec[field];
                    if (field == 'password') {
                        value = `<input style='width:100%;' id="id_display_val_password" type="password" value="${escapeHtml(value)}" readonly autocomplete="off" spellcheck="false" />`
                    }
                    else {
                        value = `<input style='width:100%;' id="id_display_val_${field}" value="${escapeHtml(value)}" readonly />`
                    }

                    /*
                    if (field == 'notes') {
                        value = value.replaceAll('\n', '<br />');
                        var min_splitter_height = 300;
                        var max_notes_height = min_splitter_height - 190;
                        var style = 'max-height:120px; overflow-y:auto; overflow-x:none;'
                        value = `<div id='id_notes_div' style='${style}'>${value}</div>`;                        
                    }
                    */
                    html += `<tr>
                        <td class='field_name'>${makeFirstUpper(field)}</td>
                        <td style='word-break:break-all;'>${value}</td>
                        </tr>`;
                }
            }
            var changes = ''
            for (var field of [['createTime','Created'],['modifyTime', 'Modified'], ['passphraseModifyTime', 'Password changed']]) {
                var pwfield = field[0]
                if (pwfield in pwrec) {
                    if (changes != '') {
                        changes +=  ',&nbsp';
                    }
                    changes += `<b>${field[1]}</b> ${daysSince(pwrec[pwfield])}`;
                }
            }
            if (changes !== '') {
                html += `<tr><td style='font-size:12px;' colspan=2>${changes}</td></tr>`;
            }

            html += '</table>';

            inrhtml('id_record', html);

            append_password_toggle("id_display_val_password");
            append_copy_icon('id_display_val_username');
            append_copy_icon('id_display_val_URL');

            attach_buttons('id_login_btns', {sep:'&nbsp;'}, treerec, [
                {id:'id_viewlogin_btn', func:function(record) { viewLoginValues(record, false) }, text:'View'},
                {id:'id_editrecs_btn', func:function(record) { viewLoginValues(record, true) }, text:'Edit'},
                {id:'id_rmlogin_btn', func:delLogin, text:'Delete'},
                {id:'id_renlogin_btn', func:renLogin, text:'Rename'},
            ]);
        }

        function display_click_data(clickdata) {
            var selectedNode = clickdata.target.target;
            g_treeview.selectNode(selectedNode);

            var leaf = (clickdata.data.children.length == 0);
            if (leaf) {
                display_record_data(clickdata);
                return;
            }

            display_folder_data(clickdata);
        }

        function open_result(idx) {
            var tree_path = idx_to_treepath(idx); // Disambiguated tree path
            if (!tree_path) {
                return;
            }
            var selNode = reload_and_expand(tree_path);
            hideModal();
        }
        
        function search_text() {
            var html = `<table id='id_search_text_header' style='width:100%; margin-bottom:5px;'>
                <tr>
                    <td>Search for</td>
                    <td><input id='id_search_text_input' style='width:95%;' /></td>
                </tr>
                </table>
                <button id='id_btn_search_text'>Search</button>&nbsp;
                <button data-action="close">Cancel</button>
                
                <div id='id_search_results' style='display:none; width:100%; margin-top:15px; height:50vh; overflow-y:auto;' ></div>
                `;

            showModal(html, {'focus_id':'id_search_text_input'});

            // Open buttons carry the record index in a data attribute; the
            // handler is attached here instead of using inline onclick.
            gebi('id_search_results').onclick = function(e) {
                var button = e.target.closest ? e.target.closest('button.open-result') : null;
                if (button) {
                    open_result(parseInt(button.getAttribute('data-index'), 10));
                }
            };

            gebi('id_btn_search_text').onclick = function() {
                gebi('id_search_results').style.display = 'block';
                var needle = gebi('id_search_text_input').value;

                var search_results = gebi('id_search_results');
                if (needle.length < 3) {
                    search_results.textContent = 'Search text should include at least 3 characters.';
                    return;
                }

                var results_html = '<table>';
                var found = false;
                for (var i=0; i<g_pwsafe.records.length; i++) {
                    var record = g_pwsafe.records[i];
                    var path = (record.group == '') ? record.title : record.group + '.' + record.title;
                    for (var property in record) {
                        if (!Object.prototype.hasOwnProperty.call(record, property)) {
                            continue;
                        }
                        var recval = record[property];
                        if (typeof(recval) !== 'string') {
                            continue;
                        }
                        if (recval.includes(needle)) {
                            var hightlighted = highlightText(recval, needle);
                            found = true;
                            results_html += `<tr>
                                <td style='word-break:break-all;'><div style='color:green'>${escapeHtml(path)}</div>
                                <b>${escapeHtml(makeFirstUpper(property))}</b>:<br />
                                ${hightlighted}</td>
                                <td style='width:1px; vertical-align:top;'><button class='open-result' data-index='${i}'>Open</button></td>
                                </tr>`;
                        }
                    }
                }
                results_html += '</table>';
                if (!found) {
                    results_html = 'No results found.';
                }
                search_results.innerHTML = results_html;
            };

        }

        function save_file() {
            if (!g_passphrase) {
                alert('Set a master password first (Set Master Password).');
                return;
            }
            if (!g_filename) {
                alert('No file is open.');
                return;
            }

            // Remove all the folder placeholders in the pwsafe records.
            g_pwsafe.records = g_pwsafe.records.filter(function(x) {
                return 'uuid' in x;
            });

            g_pwsafe.headers.lastSaveTime = new Date();
            g_pwsafe.headers.lastSaveApp = 'MyCrypt v1.0';

            var html = `
                <div style="width:100%; margin-left: auto; margin-right: auto;">Encrypting File...</div>
                <div id="id_encrypt_progress" style="width:100%; margin-left: auto; margin-right: auto;"></div>
            `;

            showModal(html, {'modal_width':'260px'});

            var encrypt_progress_bar = create_progress_bar('id_encrypt_progress');
            var options = {
                'on_progress': function(percent) {
                    encrypt_progress_bar.position(percent);
                },
                'percent_res': 5
            };

            var buffer;
            try {
                buffer = g_pwsafe.encrypt(g_passphrase, options);
            } catch (e) {
                hideModal();
                alert('Could not encrypt the file: ' + e.message);
                return;
            }
            hideModal();

            var binary = '';
            var bytes = new Uint8Array(buffer);
            var len = bytes.byteLength;
            for (var i = 0; i < len; i++) {
                binary += String.fromCharCode(bytes[i]);
            }
            var b64_encrypted = window.btoa(binary);
            var request = {
                'req':'set_file_b64content',
                'filename':g_filename,
                'data':b64_encrypted,
            };

            sendJSON(request, function(reply) {
                if (reply && 'error' in reply) {
                    alert(reply['error']);
                    return;
                }
                update_unsaved_ui(false);
            });

        }
        
        function idx_to_treepath(idx) {
            if (idx in g_index_to_unique_path) {
                return g_index_to_unique_path[idx];
            }
            return null;
        }

        function disambiguate_branch(path, leaf, options) {
            if (typeof(options) == 'object') {
                if ('rmleaf' in options && typeof(options.rmleaf) == 'string') {
                    // Before suggesting a new name for duplicate leaf, remove
                    // any references to previously disambiguated entries
                    // that currently exist as prevleaf.
                    var rmleaf = options.rmleaf;
                    var prevpath = (path == '') ? rmleaf : path + '.' + rmleaf;
                    delete g_paths_map[prevpath];
                }
            }
            var newpath = (path == '') ? leaf : path + '.' + leaf;
            var count = 1;
            var newleaf = leaf;
            while (newpath in g_paths_map) {
                count++;
                newleaf = `${leaf} (${count})`;
                newpath = (path == '') ? newleaf : path + '.' + newleaf;
            }
            g_paths_map[path] = 1;
            g_paths_map[newpath] = 1;

            if (typeof(options) == 'object' && 'index' in options) {
                g_index_to_unique_path[options.index] = newpath;
                g_unique_path_to_index[newpath] = options.index;
            }

            return newleaf;
        }

        function buildTreeStruct(records) {
            const tree = [];
            g_paths_map = {};
            g_index_to_unique_path = {};
            g_unique_path_to_index = {};

            for (var i=0; i < records.length; i++) {
                var record = records[i];
                
                // The title is going to be the last node in the tree
                // so replace all periods in the title without a preceding \\ to \\. 
                // in order that the period would not stand for a new node. 
                var title = record.title.replaceAll('.', '\\.').replaceAll('\\\\.', '\\.')
                
                var group = ('group' in record) ? record.group : '';
               
                var options = {'index': i};
                title = disambiguate_branch(group, title, options);
                var path = (group == '') ? title : group + '.' + title;

                const nodes = path.split(/(?<!\\)\./); // Split on '.' but not '\\.'

                let currentNode = tree;
                let currentPath = '';
                nodes.forEach((nodeName, index) => {
                    const name = nodeName.replace(/\\\./g, '.'); // Replace '\\.' with '.'
                    currentPath = currentPath ? `${currentPath}.${nodeName}` : nodeName; // Build the current path without replacing escaped periods

                    let node = currentNode.find(n => n.name === name);

                    if (!node) {
                        node = { name, path: currentPath, children: [] };
                        currentNode.push(node);
                    }

                    if (index === nodes.length - 1) {
                        // Leaf node, do nothing
                        node.index = i;
                        if (record.title == '') {
                            // The protocol is: empty title means don't show leaf
                            node.hidden = 1;
                        }
                    } else {
                        currentNode = node.children;
                    }
                });
            }

            sortTree(tree);
            tree.sort((a, b) => {
                return compareTreeNodes(a, b)
            });

            return tree;
        }

        function on_root_menu() {
            var menuimg = gebi('id_rootmenu_img');
            var menu = gebi('id_root_actions');
            // Position the context menu at the mouse position
            if (menu.style.display == "block") {
                menu.style.display = "none";
                return;
            }
            var rect = menuimg.getBoundingClientRect();
            menu.style.top = rect.bottom + "px";
            menu.style.left = rect.left + "px";
            menu.style.display = "block";

            var menuRect = menu.getBoundingClientRect();
            if (menuRect.right > window.innerWidth) {
                menu.style.left = "auto";
                menu.style.right = "10px";
            }
        }

        function setStyleHeight(elem, offset_height) {
            // set the style.height of DOM element elem so that
            // after setting the style.height elem.offsetHeight will
            // be equal to offset_height.

            // Get the computed styles of the element
            var style = window.getComputedStyle(elem);

            // Check if the box-sizing is border-box
            if (style.boxSizing === 'border-box') {
                // If border-box, we can set the height directly
                elem.style.height = offset_height + 'px';
            } else {
                // If not border-box, subtract padding and border from the offsetHeight
                var paddingTop = parseInt(style.paddingTop);
                var paddingBottom = parseInt(style.paddingBottom);
                var borderTop = parseInt(style.borderTopWidth);
                var borderBottom = parseInt(style.borderBottomWidth);

                // Calculate the total height to set
                var totalHeight = offset_height - paddingTop - paddingBottom - borderTop - borderBottom;
                elem.style.height = totalHeight + 'px';
            }
        }


        function build_tree() {
            window.onclick = function(e) {
                if (e.target == gebi('id_rootmenu_img')) {
                    return true;
                }
                //console.log('inside window.onclick');
                if (e.button !== 2) { // not right click
                    var elements = document.querySelectorAll('.ctxMenu');
                    // Check if the clicked element is not a .ctxmenu element or a descendant of one
                    var isClickInsideMenu = Array.from(elements).some(function(element) {
                        return element.contains(e.target);
                    });

                    if (!isClickInsideMenu) {
                        // Loop through the elements and hide them
                        for (var i = 0; i < elements.length; i++) {
                            if (window.getComputedStyle(elements[i]).display !== 'none') {
                                elements[i].style.display = 'none';
                            }
                        }
                    }
                }
                return true;
            };

            var tree = buildTreeStruct(g_pwsafe.records);

            var tree_title = "<div id='id_tree_title'>";
            
            if (!g_folders_only) {
                tree_title += `
                <img src="hmenu.svg" style='width:28px; border-radius:5px; vertical-align:middle; cursor:pointer;'
                    id='id_rootmenu_img'>
                <span style='font-size:18px; vertical-align:middle;'>&nbsp; MyCrypt</span>
                <hr />
                <div id="id_root_actions" class="ctxMenu" 
                    style='display:none;'>
                </div>`;
            }
            else {
                tree_title += `<div style='font-size:18px; vertical-align:middle;'>Select Folder</div>
                <button id='id_cancel_folder_sel'>Cancel folder selection</button>`;
            }

            tree_title += "</div>";

            var html = `<div id='content' style='width:100%; height:95vh;'>
                        <div id='id_top_panel'>
                            ${tree_title}
                            <div id='id_tree' class="no-select" style='width:100%; height:calc(100% - 60px); overflow-x:hidden; overflow-y:auto;'></div>
                        </div>

                        <div id='id_splitter'></div>

                        <div id='id_bottom_panel' style='overflow-x:hidden; overflow-y:auto;'>
                            <div id='id_record' style='width:100%; height:100%; overflow-x:auto; overflow-y: auto;'></div>
                        </div>
                    </div>`;

            html += '<div id="id_tree_ctxmenu" class="ctxMenu" style="display:none;"></div>';

            inrhtml('id_content', html);
            setZoom100();

            // Inline event handlers are not used anywhere in this file, so the
            // clicks have to be wired up after the markup is inserted.
            if (!g_folders_only) {
                var rootmenu_img = gebi('id_rootmenu_img');
                if (rootmenu_img) {
                    rootmenu_img.addEventListener('click', on_root_menu);
                }
            } else {
                var cancel_folder_btn = gebi('id_cancel_folder_sel');
                if (cancel_folder_btn) {
                    cancel_folder_btn.addEventListener('click', onCancelFolderSelection);
                }
            }

            g_treeview = new TreeView(tree, 'id_tree', g_folders_only);
            g_treeview.on('click', display_click_data);
            g_treeview.on('context', show_context_menu);

            document.onkeydown = function(e) {
                if (g_modal_shown) {
                    return;
                }
                
                if (e.keyCode == 38) { // arrow up
                    g_treeview.clickBeforeSelected();
                }
                if (e.keyCode == 40) { // arrow down
                    g_treeview.clickAfterSelected();
                }
                if (e.keyCode == 39) { // arrow right
                    g_treeview.expandAtSelected();
                }
                if (e.keyCode == 37) { // arrow left
                    g_treeview.collapseAtSelected();
                }
            }

            if (!g_folders_only) {
                var treerec = { data : { path : '' } };

                attach_buttons('id_root_actions', {class:'root-menu', sep:' '}, treerec, [
                    {id:'id_add_root_login_btn', func:folderAddLogin, text:'Add Root Login'},
                    {id:'id_add_root_folder_btn', func:folderAddFolder, text:'Add Root Folder'},
                    {id:'id_save_file_btn', func:save_file, text:'Save File'},
                    {id:'id_searchtxt_btn', func:search_text, text:'Search Text'},
                    {id:'id_setpasswd_btn', func:setPassword, text:'Set Master Password'},
                    {id:'id_lock_btn', func:lockFromMenu, text:'Lock'},
                ], true);
            }

            var title_height = gebi('id_tree_title').offsetHeight;
            var tree_div = gebi('id_tree');
            tree_div.style.height = `calc(100% - ${title_height}px);`
            attach_splitter()

            if (tree.length > 0) {
                g_treeview.clickFirstItem();
            }
        }

        // ------------------------------------------------------------------
        // Locking / auto-lock
        // ------------------------------------------------------------------

        function lockFromMenu() {
            lockDatabase(true);
        }

        function lockDatabase(manual) {
            if (manual === true && g_unsaved) {
                if (!confirm('You have unsaved changes. Locking will discard them. Continue?')) {
                    return;
                }
            }
            if (g_lock_timer) {
                clearTimeout(g_lock_timer);
                g_lock_timer = null;
            }
            // Drop all plaintext state.
            g_passphrase = null;
            g_filename = null;
            g_pwsafe = new PWSafeDB();
            g_treeview = null;
            g_folders_only = false;
            g_saved_path = null;
            g_paths_map = {};
            g_index_to_unique_path = {};
            g_unique_path_to_index = {};
            g_unsaved = false;
            hideModal();
            showMessage('id_content', '');
            if (navigator.clipboard && navigator.clipboard.writeText) {
                navigator.clipboard.writeText('').catch(function() {});
            }
            getFiles();
        }

        function resetLockTimer() {
            if (g_lock_timer) {
                clearTimeout(g_lock_timer);
                g_lock_timer = null;
            }
            if (!g_passphrase) {
                return;
            }
            g_lock_timer = setTimeout(function() {
                lockDatabase(false);
            }, AUTO_LOCK_MS);
        }

        var g_last_activity = 0;
        function onActivity() {
            var now = Date.now();
            if (now - g_last_activity < 5000) {
                return;
            }
            g_last_activity = now;
            resetLockTimer();
        }

        function attach_splitter() {
            const splitter = gebi('id_splitter');
            const topPanel = gebi('id_top_panel');
            const bottomPanel = gebi('id_bottom_panel');
            var start_bpanel_height = 270;
            var start_splitter_height = splitter.clientHeight;
            var the_rest = start_bpanel_height + start_splitter_height;
            var top_height = gebi('id_content').offsetHeight - the_rest;
            topPanel.style.height = `${top_height}px`;
            bottomPanel.style.height = `${start_bpanel_height}px`;
            let isDragging = false;

            function startDrag(e) {
                isDragging = true;
                e.preventDefault();
            }

            function onDrag(e) {
                if (!isDragging) {
                    return;
                }

                var clientY = e.clientY || (e.touches && e.touches[0].clientY);
                if (clientY == null) return;

                var min_height = 260;

                if (clientY < min_height) {
                    return;
                }

                const offsetBottom = window.innerHeight - clientY;
                if (offsetBottom < min_height) {
                    return;
                }

                topPanel.style.height = `calc(100vh - ${offsetBottom + 5}px)`;
                bottomPanel.style.height = `${offsetBottom - 15}px`;
            }

            function stopDrag() {
                isDragging = false;
            }

            splitter.onmousedown = startDrag;
            document.onmousemove = onDrag;
            document.onmouseup = stopDrag;

            splitter.ontouchstart = startDrag;
            document.ontouchmove = onDrag;
            document.ontouchend = stopDrag;
        }

        function sendJSON(json, callback) {
            // Every request except the token request itself needs the session
            // CSRF token, so fetch it lazily on the first call.
            if (!json || json.req !== 'csrf') {
                if (!g_csrf) {
                    ensureCsrf(function(reply) {
                        if (!g_csrf) {
                            // Pass the real server error through (for example
                            // "not configured" or "HTTPS required") instead of
                            // masking it with a generic auth message.
                            if (reply && reply.error) {
                                callback(reply);
                            } else {
                                callback({'error': 'Authentication required. Reload the page and sign in.'});
                            }
                            return;
                        }
                        sendJSON(json, callback);
                    });
                    return;
                }
            }

            var done = false;
            function finish(params) {
                if (done) {
                    return;
                }
                done = true;
                hideModal();
                callback(params);
            }

            var html = '<div style="text-align:center;">Please wait...<br /><img src="loader.svg" /><div>';
            showModal(html, {'modal_width':'260px'});
            var xhr = new XMLHttpRequest();
            xhr.open("POST", 'manager.php', true);
            xhr.setRequestHeader("Content-Type", "application/json");
            if (g_csrf) {
                xhr.setRequestHeader("X-CSRF-Token", g_csrf);
            }
            xhr.timeout = 120000;
            xhr.onreadystatechange = function() {
                if (this.readyState !== 4) {
                    return;
                }
                var reply = null;
                try {
                    reply = JSON.parse(this.responseText);
                } catch (e) {
                    reply = null;
                }
                if (this.status === 200 && reply !== null) {
                    finish(reply);
                    return;
                }
                if (this.status === 401) {
                    g_csrf = null;
                    finish({'error': 'Authentication required. Reload the page and sign in.'});
                    return;
                }
                if (this.status === 403) {
                    // The PHP session may have expired; fetch a fresh token on
                    // the next action instead of retrying in a loop.
                    g_csrf = null;
                }
                var message = (reply && reply.error) ? reply.error : ('Request failed with status ' + this.status);
                finish({'error': message});
            };
            xhr.ontimeout = function() {
                finish({'error': 'The request timed out.'});
            };
            xhr.onerror = function() {
                finish({'error': 'Network error'});
            };
            xhr.send(JSON.stringify(json));
        }

        // The session-bound CSRF token is fetched once, before the first
        // state-changing request, and sent as a custom header (which a
        // cross-site form/fetch cannot do).
        function ensureCsrf(callback) {
            if (g_csrf) {
                callback();
                return;
            }
            sendJSON({'req':'csrf'}, function(reply) {
                if (reply && typeof(reply.csrf) === 'string') {
                    g_csrf = reply.csrf;
                }
                callback(reply);
            });
        }


        function rmExt(filename) {
            var parts = filename.split('.');
            if (parts.length > 1) {
                parts.pop(); // Remove the last element (the extension)
            }
            return parts.join('.');
        }

        function inrhtml(id, str) {
            gebi(id).innerHTML = str;
        }

        function openFile( filename ) {
            var passInput = gebi('id_file_password');
            g_passphrase = passInput ? passInput.value : '';

            if (!g_passphrase) {
                alert('Please enter the master password.');
                return;
            }
            if (!/^[A-Za-z0-9][A-Za-z0-9 _-]{0,63}$/.test(filename)) {
                alert('Invalid file name.');
                return;
            }

            // Keep the master password out of the DOM once it has been read.
            if (passInput) {
                passInput.value = '';
            }
            g_filename = filename;
            g_pwsafe = new PWSafeDB();

            sendJSON({'req':'get_file_b64content', 'filename':filename}, function(reply) {
                if (!reply || 'error' in reply) {
                    alert((reply && reply.error) ? reply.error : 'Unable to load the file.');
                    return;
                }

                function on_decryption(pdb)
                {
                    hideModal();

                    if (pdb instanceof Error) {
                        g_passphrase = null;
                        g_filename = null;
                        alert(pdb.message);
                        return;
                    }

                    update_unsaved_ui(false);
                    resetLockTimer();
                    build_tree();
                }

                var options = { 
                    'strictFieldTypeCheck':true,
                    'on_progress':on_decrypt_progress,
                    'on_complete':on_decryption,
                    'percent_res':5
                };

                var html = `
                <div style="width:100%; margin-left: auto; margin-right: auto;">Decrypting File...</div>
                <div id="id_decrypt_progress" style="width:100%; margin-left: auto; margin-right: auto;"></div>`
                showModal(html, {'modal_width':'260px'});

                var decrypt_progress_bar = create_progress_bar('id_decrypt_progress');

                function on_decrypt_progress(percent) {
                    decrypt_progress_bar.position(percent);
                }

                var binary;
                try {
                    binary = window.atob(reply['file_b64_content']);
                } catch (e) {
                    hideModal();
                    g_passphrase = null;
                    g_filename = null;
                    alert('The server returned invalid file data.');
                    return;
                }

                g_pwsafe.decrypt(binary, g_passphrase, options);
            });
        }

        function getPassFor( filename ) {
            var container = gebi('id_content');
            container.textContent = '';

            var wrapper = document.createElement('div');
            wrapper.style.cssText = 'width:95%; display:flex; align-items:center;';

            var label = document.createElement('div');
            label.style.cssText = 'text-align:right; margin-right:5px;';
            label.textContent = 'Password';

            var input = document.createElement('input');
            input.id = 'id_file_password';
            input.type = 'password';
            input.value = '';
            input.autocomplete = 'off';
            input.spellcheck = false;

            var button = document.createElement('button');
            button.id = 'id_open_file_btn';
            button.textContent = 'Open';
            button.addEventListener('click', function() {
                openFile(filename);
            });

            wrapper.appendChild(label);
            wrapper.appendChild(input);
            wrapper.appendChild(button);
            container.appendChild(wrapper);

            append_password_toggle("id_file_password", false);
            setTimeout(function() {
                input.focus();
            }, 100);
            input.addEventListener('keydown', function(e) {
                if (e.key === 'Enter') {
                    button.click();
                }
            });
        }

        function getFiles() {
            sendJSON({'req':'pwfiles'}, function(reply) {
                if (!reply || !Array.isArray(reply.pwfiles)) {
                    showMessage('id_content', (reply && reply.error) ? reply.error : 'Unable to list files.');
                    return;
                }

                var files = reply.pwfiles;
                var container = gebi('id_content');
                container.textContent = '';

                var table = document.createElement('table');
                for (var i=0; i<files.length; i++) {
                    var file = rmExt(files[i]);
                    var row = document.createElement('tr');

                    var nameCell = document.createElement('td');
                    nameCell.textContent = file;
                    row.appendChild(nameCell);

                    var buttonCell = document.createElement('td');
                    var openButton = document.createElement('button');
                    openButton.textContent = 'Open';
                    (function(name) {
                        openButton.addEventListener('click', function() {
                            getPassFor(name);
                        });
                    })(file);
                    buttonCell.appendChild(openButton);
                    row.appendChild(buttonCell);

                    table.appendChild(row);
                }
                container.appendChild(table);

                if (files.length === 0) {
                    var empty = document.createElement('div');
                    empty.textContent = 'No password files found.';
                    container.appendChild(empty);
                }
            });
        }

        // ------------------------------------------------------------------
        // Startup / lifecycle
        // ------------------------------------------------------------------

        document.addEventListener('DOMContentLoaded', function() {
            if (g_startup_error) {
                var container = gebi('id_content');
                if (container) {
                    container.textContent = g_startup_error;
                }
                return;
            }

            getFiles();

            ['mousemove', 'mousedown', 'keydown', 'touchstart', 'scroll'].forEach(function(name) {
                document.addEventListener(name, onActivity, {passive: true});
            });

            document.addEventListener('visibilitychange', function() {
                if (document.hidden) {
                    g_hidden_at = Date.now();
                } else if (g_hidden_at && Date.now() - g_hidden_at > AUTO_LOCK_MS) {
                    lockDatabase(false);
                }
            });

            window.addEventListener('beforeunload', function(e) {
                if (g_unsaved) {
                    e.preventDefault();
                    e.returnValue = '';
                    return '';
                }
            });

            // Do not leave decrypted material in the page when it is restored
            // from the back/forward cache.
            window.addEventListener('pageshow', function(e) {
                if (e.persisted) {
                    lockDatabase(false);
                }
            });
        });

        
    