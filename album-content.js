// album-content.js

const BACKEND_URL = 'https://myphotostorage-backend.zeabur.app'; 
let currentAlbumId = null; 
let allPhotos = []; 
let currentPhotoIndex = 0; 
let selectedPhotoIds = new Set(); 
let isBulkMove = false; // 追蹤目前是批量移動還是單張移動

function getUrlParams() {
    const params = new URLSearchParams(window.location.search);
    return { id: params.get('id'), name: decodeURIComponent(params.get('name') || '相簿') };
}

function showMessage(type, content) {
    const msg = document.getElementById('message');
    if (!msg) return; 
    
    // 設置錯誤訊息的顯示時間為 8 秒，成功訊息為 3 秒
    const duration = (type === 'error') ? 8000 : 3000;
    
    msg.className = `message-box ${type}`;
    msg.innerHTML = content;
    msg.style.display = 'block';
    
    // 設置定時器來隱藏訊息
    setTimeout(() => {
        // 確保只有當前訊息還在顯示時才隱藏
        if (msg.style.display !== 'none') {
            msg.style.display = 'none';
        }
    }, duration);
}

// 判斷是否為影片檔案
function isVideo(filename) {
    return filename.match(/\.(mp4|mov|webm|ogg)$/i);
}

async function loadAlbumContent() {
    const { id, name } = getUrlParams();
    if (!id) return;
    
    document.getElementById('currentAlbumName').textContent = name;
    document.title = name;
    currentAlbumId = id;
    
    const grid = document.getElementById('photoGrid');
    // 注意：這裡不再獲取 noPhotosMessage，因為它會被 grid.innerHTML = ''; 銷毀
    
    // 步驟 1: 設置載入狀態
    grid.innerHTML = '<p>載入中...</p>';

    try {
        const res = await fetch(`${BACKEND_URL}/api/albums/${id}/photos`);
        
        if (!res.ok) {
            throw new Error(`API 載入失敗 (狀態碼: ${res.status})`);
        }
        
        const photos = await res.json();
        allPhotos = photos;
        
        // 步驟 2: 成功取得資料，清除載入中狀態 (同時銷毀原有的 #noPhotosMessage 元素)
        grid.innerHTML = ''; 
        
        selectedPhotoIds.clear();
        document.getElementById('bulkActions').style.display = 'none';

       if (photos.length === 0) {
            grid.innerHTML = '';
            grid.classList.add('empty-grid'); // 加入置中專用的樣式
    
            const msg = document.createElement('p');
            msg.id = 'noPhotosMessage';
            msg.textContent = '此相簿目前沒有留影';
    
            grid.appendChild(msg);  
            return;
        } else {
            grid.classList.remove('empty-grid'); // 有照片時移除置中樣式
        }

        // 步驟 3: 渲染照片/影片網格
        photos.forEach((photo, index) => {
            const card = document.createElement('div');
            card.className = 'photo-card';
            card.setAttribute('data-photo-id', photo._id); 

            // 判斷顯示圖片或影片
            let mediaHtml = '';
            if (isVideo(photo.originalFileName)) {
                // 影片縮圖處理
                mediaHtml = `
                    <div class="video-indicator">▶</div>
                    <video src="${photo.githubUrl}#t=0.1" preload="metadata" poster="data:image/gif;base64,R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw=="></video>
                `;
            } else {
                mediaHtml = `<img src="${photo.githubUrl}" alt="photo">`;
            }

            // ⭐ START: 替換區塊 ⭐
            card.innerHTML = `
                <input type="checkbox" class="photo-select-checkbox" onclick="handleSelectionClick(event, '${photo._id}', '${photo.originalFileName}')">
                <div class="media-wrapper" onclick="openLightbox(${index}); event.stopPropagation();">
                    ${mediaHtml}
                </div>
                <div class="photo-info">
                    <span class="photo-filename" title="${photo.originalFileName}">${photo.originalFileName}</span>
                </div>
                <div class="photo-actions">
                    <button onclick="showRenamePhotoModal('${photo._id}', '${photo.originalFileName}'); event.stopPropagation();" class="icon-btn rename" title="重新命名">
                        <svg viewBox="0 0 24 24"><path d="M14.06,9.02L15,9.94L5.92,19H5V18.08L14.06,9.02M17.66,3C17.41,3 17.15,3.1 16.96,3.29L15.13,5.12L18.88,8.87L20.71,7.04C21.1,6.65 21.1,6 20.71,5.63L18.37,3.29C18.17,3.09 17.92,3 17.66,3M14.06,6.19L3,17.25V21H6.75L17.81,9.94L14.06,6.19Z" /></svg>
                    </button>
                    <button onclick="singleDeletePhoto('${photo._id}'); event.stopPropagation();" class="icon-btn delete" title="刪除">
                        <svg viewBox="0 0 24 24"><path d="M9,3V4H4V6H5V19C5,20.1 5.9,21 7,21H17C18.1,21 19,20.1 19,19V6H20V4H15V3H9M7,6H17V19H7V6M9,8V17H11V8H9M13,8V17H15V8H13Z" /></svg>
                    </button>
                    <button onclick="showMovePhotoModal(false, '${photo._id}', '${photo.originalFileName}'); event.stopPropagation();" class="icon-btn move" title="移動">
                        <svg viewBox="0 0 24 24"><path d="M20,11V13H8L13.5,18.5L12.08,19.92L4.16,12L12.08,4.08L13.5,5.5L8,11H20Z" /></svg>
                    </button>
                </div>
            `;
            // ⭐ END: 替換區塊 ⭐
            grid.appendChild(card);
        });
        
        // 照片渲染完成後，給每張卡片隨機旋轉
        document.querySelectorAll('.photo-card').forEach(card => {
            const angle = Math.random() * 10 - 5; // -5 到 5 度
            card.style.setProperty('--r', `${angle}deg`);
        });

    } catch (e) {
        // 步驟 4: 處理錯誤
        console.error("載入相簿內容時發生錯誤：", e);
        grid.innerHTML = '<p class="error-text">❌ 載入失敗，請檢查網路或後端服務。</p>'; 
    }
}

// --- 燈箱邏輯 --- (略)
function openLightbox(index) {
    currentPhotoIndex = index;
    const lightbox = document.getElementById('lightbox');
    lightbox.style.display = 'flex';
    document.body.style.overflow = 'hidden'; 
    displayLightboxContent(index);
    document.addEventListener('keydown', handleKeyNavigation);
}

function displayLightboxContent(index) {
    const photo = allPhotos[index];
    const wrapper = document.querySelector('.lightbox-content-wrapper');
    
    // 清除舊內容
    const oldImg = document.getElementById('lightboxImage');
    const oldVideo = document.getElementById('lightboxVideo');
    if(oldImg) oldImg.remove();
    if(oldVideo) oldVideo.remove();

    const caption = document.getElementById('imageCaption');
    if(caption) caption.textContent = photo.originalFileName;

    // 建立新的元素
    if (isVideo(photo.originalFileName)) {
        const video = document.createElement('video');
        video.id = 'lightboxVideo';
        video.src = photo.githubUrl;
        video.controls = true;
        video.autoplay = true;
        // 插入到按鈕之間
        const nextBtn = document.getElementById('nextBtn');
        wrapper.insertBefore(video, nextBtn);
    } else {
        const img = document.createElement('img');
        img.id = 'lightboxImage';
        img.src = photo.githubUrl;
        // 插入到按鈕之間
        const nextBtn = document.getElementById('nextBtn');
        wrapper.insertBefore(img, nextBtn);
    }
}

function closeLightbox() {
    document.getElementById('lightbox').style.display = 'none';
    document.body.style.overflow = 'auto';
    // 停止影片播放
    const video = document.getElementById('lightboxVideo');
    if(video) video.pause();
    document.removeEventListener('keydown', handleKeyNavigation);
}

function navigatePhoto(dir) {
    currentPhotoIndex = (currentPhotoIndex + dir + allPhotos.length) % allPhotos.length;
    displayLightboxContent(currentPhotoIndex);
}

function handleKeyNavigation(e) {
    if (e.key === 'ArrowLeft') navigatePhoto(-1);
    if (e.key === 'ArrowRight') navigatePhoto(1);
    if (e.key === 'Escape') closeLightbox();
}

// --- 選取與刪除邏輯 ---

function handleSelectionClick(e, id, name) {
    e.stopPropagation();
    
    let currentSelections = Array.from(selectedPhotoIds); // 將 Set 轉換成可操作的陣列

    if (e.target.checked) {
        // 新增：確保 ID 和 NAME 的組合是唯一的
        currentSelections.push({ id, name }); 
    } else {
        // 移除：使用 filter 找到並移除對應 ID 的物件
        currentSelections = currentSelections.filter(item => item.id !== id);
    }
    
    // 重新賦值給 Set
    selectedPhotoIds = new Set(currentSelections);
    
    const bulkDiv = document.getElementById('bulkActions');
    if (selectedPhotoIds.size > 0) {
        bulkDiv.style.display = 'flex';
        document.getElementById('selectedCount').textContent = `已選 ${selectedPhotoIds.size} 張`;
    } else {
        bulkDiv.style.display = 'none';
    }
}

// --- 全選按鈕邏輯 ---

// --- 全選按鈕邏輯 ---

function toggleSelectAll() {
    const isAllSelected = selectedPhotoIds.size === allPhotos.length;
    selectedPhotoIds.clear();
    const checkboxes = document.querySelectorAll('.photo-select-checkbox');
    
    checkboxes.forEach((checkbox, index) => {
        checkbox.checked = !isAllSelected; // 根據當前狀態切換
        if (!isAllSelected) {
            const photo = allPhotos[index];
            // ⭐ 修正：儲存物件 { id, name }
            selectedPhotoIds.add({ id: photo._id, name: photo.originalFileName });
        }
    });

    const bulkDiv = document.getElementById('bulkActions');
    if (selectedPhotoIds.size > 0) {
        bulkDiv.style.display = 'flex';
        document.getElementById('selectedCount').textContent = `已選 ${selectedPhotoIds.size} 張`;
    } else {
        bulkDiv.style.display = 'none';
    }
}

// --- 單張重新命名 Modal ---

function showRenamePhotoModal(id, oldName) {
    document.getElementById('renamePhotoId').value = id;
    document.getElementById('currentPhotoNameDisplay').textContent = oldName;
    document.getElementById('newPhotoNameInput').value = oldName.substring(0, oldName.lastIndexOf('.')); // 預設去除副檔名
    document.getElementById('renamePhotoModal').style.display = 'block';
}

// --- 執行重新命名邏輯 (最終修正：正確的鍵值與路由) ---

async function executeRenamePhoto() {
    const id = document.getElementById('renamePhotoId').value;
    const newNameWithoutExt = document.getElementById('newPhotoNameInput').value.trim();
    const currentName = document.getElementById('currentPhotoNameDisplay').textContent;
    const lastDotIndex = currentName.lastIndexOf('.');
    const ext = lastDotIndex === -1 ? '' : currentName.substring(lastDotIndex);
    
    if (!newNameWithoutExt) return showMessage('error', '新名稱不可為空');

    const newName = newNameWithoutExt + ext; // 重新組合完整檔名
    
    // ⭐ 關鍵修正 1: JSON Body 只傳遞後端期望的 'originalFileName'
    const requestBody = JSON.stringify({ originalFileName: newName }); 
    
    document.getElementById('renamePhotoModal').style.display = 'none';

    try {
        // ⭐ 關鍵修正 2: URL 必須包含 photoId，匹配後端 PUT /api/photos/:id
        const apiUrl = `${BACKEND_URL}/api/photos/${id}`;
        
        console.log("Renaming Photo Request:", { url: apiUrl, body: requestBody });
        
        const res = await fetch(apiUrl, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: requestBody 
        });

        if (res.ok) {
            // ✅ 成功邏輯：強制重新載入以確認伺服器變更
            showMessage('success', `✅ 重新命名請求已送出，頁面將重新載入以確認變更...`);
            
            localStorage.setItem('albums_data_changed', 'true'); 
            window.location.reload(); 
            
        } else {
            // ❌ 失敗邏輯：捕捉伺服器錯誤細節
            const errorText = await res.text();
            let errorData = { message: errorText || 'API 回應內容為空' };
            try {
                errorData = JSON.parse(errorText);
            } catch (e) {
                // 如果不是 JSON，則使用原始文字
            }

            console.error('重新命名 API 失敗 (Response Details):', res.status, errorData);
            showMessage('error', `❌ 重新命名失敗！ (狀態碼: ${res.status}, 伺服器訊息: ${errorData.message || '無'})。請檢查瀏覽器控制台 (F12) 獲取詳細資訊。`);
        }
        
    } catch (e) {
        // ❌ 網路連線錯誤
        console.error("網路/JSON 解析錯誤：", e);
        showMessage('error', `❌ 網路連線錯誤或資料處理失敗。請檢查網路或控制台 (F12) 獲取詳細資訊。`);
    }
}

// --- 執行批量刪除 (修正 ID 提取) ---

async function bulkDeletePhotos() {
    if (!confirm(`確定要刪除這 ${selectedPhotoIds.size} 張留影嗎？`)) return;
    
    // ⭐ 修正：從 Set 中的物件提取 ID
    const photoIdsToDelete = Array.from(selectedPhotoIds).map(item => item.id);
    
    try {
        await fetch(`${BACKEND_URL}/api/photos/bulkDelete`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ photoIds: photoIdsToDelete })
        });
        showMessage('success', `✅ 成功刪除 ${photoIdsToDelete.length} 張留影。`);
        loadAlbumContent(); 
    } catch (e) {
        showMessage('error', '刪除失敗');
    }
}

async function singleDeletePhoto(id) {
    if (!confirm('確定要刪除此留影嗎？')) return;
    try {
        await fetch(`${BACKEND_URL}/api/photos/bulkDelete`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ photoIds: [id] })
        });
        showMessage('success', '✅ 成功刪除 1 張留影。');
        loadAlbumContent();
    } catch (e) {
        showMessage('error', '刪除失敗');
    }
}

// --- 移動照片邏輯 (新增) ---

async function fetchAlbumsForMove() {
    const select = document.getElementById('targetMoveAlbumSelect');
    select.innerHTML = '';
    try {
        const res = await fetch(`${BACKEND_URL}/api/albums`);
        const albums = await res.json();
        
        albums.forEach(album => {
            // 排除當前相簿
            if (album._id === currentAlbumId) return; 
            
            const opt = document.createElement('option');
            opt.value = album._id;
            opt.textContent = album.name;
            select.appendChild(opt);
        });
        
        if (select.children.length === 0) {
            select.innerHTML = '<option value="">無其他相簿可移動</option>';
            document.getElementById('confirmMovePhoto').disabled = true;
        } else {
            document.getElementById('confirmMovePhoto').disabled = false;
        }

    } catch (e) { 
        console.error('載入相簿失敗', e);
        select.innerHTML = '<option value="">載入失敗</option>';
        document.getElementById('confirmMovePhoto').disabled = true;
    }
}

function showMovePhotoModal(isBulk, singleId = null, singleName = null) {
    isBulkMove = isBulk;
    document.getElementById('movePhotoModal').style.display = 'block';
    
    // 載入相簿清單 (每次開啟都重新載入，確保清單是最新的)
    fetchAlbumsForMove(); 
    
    const messageElement = document.getElementById('movePhotoMessage');
    const nameElement = document.getElementById('photoToMoveName');
    
    if (isBulk) {
        // 批量移動
        messageElement.textContent = `將 ${selectedPhotoIds.size} 張留影移動到：`;
        nameElement.style.display = 'none'; // 隱藏單張名稱顯示
        document.getElementById('confirmMovePhoto').onclick = executeMovePhoto;
        
    } else {
        // 單張移動
        if (!singleId) return;
        messageElement.textContent = `將 `;
        nameElement.style.display = 'inline';
        nameElement.textContent = singleName;
        messageElement.insertAdjacentElement('beforeend', nameElement);
        messageElement.insertAdjacentText('beforeend', ' 移動到：');
        
        // 將單張照片 ID 暫存到確認按鈕的 data 屬性，以便執行時使用
        document.getElementById('confirmMovePhoto').dataset.singleId = singleId;
        document.getElementById('confirmMovePhoto').onclick = executeMovePhoto;
    }
}

async function executeMovePhoto() {
    const targetAlbumId = document.getElementById('targetMoveAlbumSelect').value;
    if (!targetAlbumId) return showMessage('error', '請選擇目標相簿');

    let photoIdsToMove = [];
    if (isBulkMove) {
        // ⭐ 修正：從 Set 中的物件提取 ID
        photoIdsToMove = Array.from(selectedPhotoIds).map(item => item.id);
    } else {
        const singleId = document.getElementById('confirmMovePhoto').dataset.singleId;
        if (!singleId) return showMessage('error', '單張移動 ID 遺失');
        photoIdsToMove = [singleId];
    }
    
    if (photoIdsToMove.length === 0) return;

    // 關閉 Modal
    document.getElementById('movePhotoModal').style.display = 'none';

    try {
        const res = await fetch(`${BACKEND_URL}/api/photos/bulkMove`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
                photoIds: photoIdsToMove, 
                targetAlbumId: targetAlbumId // 確保是 targetAlbumId
            })
        });
        
        // 檢查回應是否成功
        if (res.ok) {
            showMessage('success', `✅ 成功移動 ${photoIdsToMove.length} 張留影！頁面將自動重新整理...`);
            
            // ⭐ 關鍵修正 1: 通知主頁面更新
            localStorage.setItem('albums_data_changed', 'true'); 
            
            // ⭐ 關鍵修正 2: 執行強制頁面重新載入
            window.location.reload(); 
            
        } else {
            // 讀取 API 回傳的錯誤訊息
            const errorData = await res.json().catch(() => ({ message: res.statusText || '未知錯誤' }));
            console.error('移動失敗詳情:', errorData);
            showMessage('error', `移動失敗 (錯誤碼: ${res.status}，請檢查控制台)`);
            // 失敗後，嘗試重新載入相簿內容，以便使用者可以繼續操作
            loadAlbumContent();
        }

    } catch (e) {
        console.error('網路錯誤，移動失敗', e);
        showMessage('error', '網路錯誤，移動失敗');
        loadAlbumContent(); // 網路錯誤也嘗試重新載入
    }
}


// 暴露給 HTML
document.addEventListener('DOMContentLoaded', () => {
    loadAlbumContent();
    window.openLightbox = openLightbox;
    window.closeLightbox = closeLightbox;
    window.navigatePhoto = navigatePhoto;
    window.handleSelectionClick = handleSelectionClick;
    window.bulkDeletePhotos = bulkDeletePhotos;
    window.singleDeletePhoto = singleDeletePhoto;
    window.showMovePhotoModal = showMovePhotoModal; // 暴露新功能
    window.executeMovePhoto = executeMovePhoto; // 暴露新功能
});