// upload.js (帶有輪詢機制的後端壓縮版，使用 Canvas 截取影片靜態縮圖)

const BACKEND_URL = 'https://myphotostorage-backend.zeabur.app'; 
let selectedFiles = []; 
let activeTaskIds = []; // 追蹤所有正在處理的任務 ID
let pollingInterval = null; // 輪詢計時器
let mediaTasks = {}; // 全域任務追蹤物件

// DOM 元素
const uploadButton = document.getElementById('uploadButton');
const compressionProgressDiv = document.getElementById('compressionProgress'); 
const progressList = document.getElementById('progressList');
const previewGrid = document.getElementById('previewGrid'); 
const emptyState = document.getElementById('emptyState'); 

// ----------------------------------------------------
// showMessage 函式
// ----------------------------------------------------
function showMessage(type, content) {
    const msg = document.getElementById('message');
    msg.className = `message-box ${type}`;
    msg.innerHTML = content;
    msg.style.display = 'block';
    setTimeout(() => msg.style.display = 'none', 3000);
}
window.showMessage = showMessage;

// ----------------------------------------------------
// 載入相簿選單
// ----------------------------------------------------
async function fetchAlbumsForSelect() {
    const select = document.getElementById('targetAlbumSelect');
    try {
        const res = await fetch(`${BACKEND_URL}/api/albums`); 
        const albums = await res.json();
        select.innerHTML = '';
        
        if (albums.length === 0) {
            select.innerHTML = '<option>無相簿</option>';
            return;
        }

        albums.forEach(album => {
            const opt = document.createElement('option');
            opt.value = album._id;
            opt.textContent = album.name;
            if (album.name === '未分類相簿') opt.selected = true;
            select.appendChild(opt);
        });
        if (selectedFiles.length > 0) {
            uploadButton.disabled = false;
        }
    } catch (e) { 
        console.error(e); 
        showMessage('error', '載入相簿清單失敗。');
    }
}

// ----------------------------------------------------
// 輔助函式：渲染預覽圖 (使用 Canvas 截取影片靜態縮圖，並優化圖片處理)
// ----------------------------------------------------
function renderPreview(file) {
    // 預覽項目容器
    const previewItem = document.createElement('div');
    previewItem.className = 'preview-item';
    previewItem.dataset.name = file.name;
    
    // 移除按鈕
    const removeBtn = document.createElement('button');
    removeBtn.className = 'remove-btn';
    removeBtn.innerHTML = '×';
    removeBtn.onclick = (e) => {
        e.stopPropagation();
        selectedFiles = selectedFiles.filter(f => f.name !== file.name);
        previewItem.remove();
        if (selectedFiles.length === 0) {
            emptyState.style.display = 'block';
            uploadButton.disabled = true;
        }
    };
    // 將移除按鈕加到容器
    previewItem.appendChild(removeBtn);
    // 將容器加到網格
    previewGrid.appendChild(previewItem);

    const fileURL = URL.createObjectURL(file);

    if (file.type.startsWith('image/')) {
        // ⭐ 優化點：圖片：改用 createElement/appendChild
        const reader = new FileReader();
        reader.onload = (e) => {
            const img = document.createElement('img');
            img.src = e.target.result;
            img.alt = file.name;
            img.className = 'img-thumbnail'; // 新增 class
            previewItem.appendChild(img);
        };
        reader.readAsDataURL(file);
        
    } else if (file.type.startsWith('video/') || file.name.toLowerCase().endsWith('.mov')) {
        // 影片：使用 <video> + <canvas> 截取靜態縮圖
        const video = document.createElement('video');
        video.src = fileURL;
        video.preload = 'metadata'; // 只載入元數據，輕量化
        video.muted = true;
        video.style.display = 'none'; // 隱藏影片元素
        // 必須將 video 元素加到 DOM 中才能觸發載入
        previewItem.appendChild(video); 

        const placeholder = document.createElement('div');
        placeholder.className = 'loading-placeholder';
        placeholder.innerHTML = '⚙️ 正在生成影片縮圖...';
        previewItem.appendChild(placeholder);


        video.onloadedmetadata = function() {
            video.currentTime = 0.1; // 嘗試跳到第一幀
        };
        
        video.onseeked = function() {
            // 影片跳轉到 0.1s 後，開始截圖
            const canvas = document.createElement('canvas');
            const w = video.videoWidth;
            const h = video.videoHeight;
            canvas.width = w;
            canvas.height = h;

            const ctx = canvas.getContext('2d');
            ctx.drawImage(video, 0, 0, w, h);

            // 將 canvas 內容轉為靜態圖片 URL
            const dataURL = canvas.toDataURL('image/jpeg');

            // 替換佔位符為靜態縮圖
            previewItem.removeChild(placeholder);
            
            const img = document.createElement('img');
            img.src = dataURL;
            img.alt = "影片縮圖";
            img.className = "video-thumbnail";
            previewItem.appendChild(img);

            // 顯示影片資訊
            const videoSizeMB = (file.size / 1024 / 1024).toFixed(1);
            const videoInfo = document.createElement('div');
            videoInfo.className = 'video-info';
            videoInfo.innerHTML = `🎥 ${videoSizeMB}MB`;
            previewItem.appendChild(videoInfo);
            
            // 釋放資源
            URL.revokeObjectURL(fileURL);
            video.remove();
        };

        // 如果影片載入失敗，顯示錯誤佔位符
        video.onerror = function() {
            placeholder.innerHTML = '❌ 影片載入失敗 (無法生成縮圖)';
            URL.revokeObjectURL(fileURL);
            video.remove();
        };
        
    } else {
        // 其他不支援的格式或 HEIC 
        const sizeMB = (file.size / 1024 / 1024).toFixed(1);
        const filePlaceholder = document.createElement('div');
        filePlaceholder.className = 'file-placeholder';
        filePlaceholder.innerHTML = `❓ 檔案 (${sizeMB}MB)`;
        previewItem.appendChild(filePlaceholder);
        // 釋放資源
        URL.revokeObjectURL(fileURL);
    }
}


// ----------------------------------------------------
// 輔助函式：處理檔案選取
// ----------------------------------------------------
function handleFiles(files) {
    if (files.length === 0) return;

    // 清空舊檔案
    selectedFiles = []; 
    previewGrid.innerHTML = '';
    
    // 處理新選取的檔案
    Array.from(files).forEach(file => {
        const mime = file.type;
        const name = file.name.toLowerCase();
        if (
            mime.startsWith('image/') || 
            mime.startsWith('video/') ||
            name.endsWith('.heic') ||
            name.endsWith('.heif') ||
            name.endsWith('.mov')
        ) {
            selectedFiles.push(file);
            renderPreview(file);
        } else {
            showMessage('warning', `檔案 ${file.name} 格式不支援，已跳過。`);
        }
    });

    if (selectedFiles.length > 0) {
        emptyState.style.display = 'none';
        uploadButton.disabled = false;
    } else {
        emptyState.style.display = 'block';
        uploadButton.disabled = true;
    }
}


// ----------------------------------------------------
// 任務狀態追蹤與輪詢
// ----------------------------------------------------

function updateProgressUI() {
    progressList.innerHTML = '';
    let allCompleted = true;

    const activeTasks = activeTaskIds.map(id => mediaTasks[id]).filter(task => task && task.status !== 'CLEANED');
    
    activeTasks.forEach(task => {

        const statusClass = {
            'PENDING': 'progress-pending',
            'PROCESSING': 'progress-processing',
            'COMPLETED': 'progress-success',
            'FAILED': 'progress-error'
        }[task.status] || 'progress-pending';

        const icon = {
            'PENDING': '⏳',
            'PROCESSING': '⚙️',
            'COMPLETED': '✅',
            'FAILED': '❌'
        }[task.status] || '❓';

        if (task.status !== 'COMPLETED' && task.status !== 'FAILED') {
            allCompleted = false;
        }

        const listItem = document.createElement('div');
        listItem.className = `progress-item ${statusClass}`;
        
        listItem.innerHTML = `${icon} <strong>${task.originalFileName}</strong>: ${task.message}`;
        progressList.appendChild(listItem);
    });

    if (activeTaskIds.length > 0) {
        compressionProgressDiv.style.display = 'block';
    } else {
        compressionProgressDiv.style.display = 'none';
    }

    if (allCompleted && activeTaskIds.length > 0) {
        clearInterval(pollingInterval);
        pollingInterval = null;
        
        localStorage.setItem('albums_data_changed', 'true');
        
        const totalCount = activeTaskIds.length;
        const failedCount = activeTaskIds.filter(id => mediaTasks[id] && mediaTasks[id].status === 'FAILED').length;
        
        if (failedCount === totalCount) {
            showMessage('error', `❌ 所有 ${totalCount} 個檔案處理失敗，請檢查日誌。`);
        } else if (failedCount > 0) {
            showMessage('warning', `⚠️ 處理完成。${totalCount - failedCount} 個成功，${failedCount} 個失敗。`);
        } else {
            showMessage('success', `✅ 所有 ${totalCount} 個檔案處理完成！請查看相簿。`);
        }
        
        setTimeout(() => {
            activeTaskIds.forEach(id => {
                if (mediaTasks[id]) {
                    mediaTasks[id].status = 'CLEANED';
                }
            });
            activeTaskIds = []; 
            compressionProgressDiv.style.display = 'none';
        }, 10000); 

        uploadButton.disabled = false;
        uploadButton.innerHTML = `<svg viewBox="0 0 24 24" style="width:20px; height:20px; fill:white;"><path d="M9,16V10H5L12,3L19,10H15V16H9M5,20V18H19V20H5Z" /></svg> <span>上傳</span>`;
    }
}


async function pollTaskStatus() {
    if (activeTaskIds.length === 0) {
        clearInterval(pollingInterval);
        pollingInterval = null;
        return;
    }

    const idsToPoll = [...activeTaskIds]; 
    const tasks = {}; 

    for (const taskId of idsToPoll) {
        try {
            const res = await fetch(`${BACKEND_URL}/api/tasks/status/${taskId}`);
            if (res.ok) {
                const taskStatus = await res.json();
                tasks[taskId] = { ...mediaTasks[taskId], ...taskStatus };
            } else {
                tasks[taskId] = { status: 'FAILED', message: '任務在伺服器端已過期或不存在。', originalFileName: mediaTasks[taskId] ? mediaTasks[taskId].originalFileName : '未知檔案' };
            }
        } catch (e) {
            console.error(`輪詢任務 ${taskId} 失敗:`, e);
            tasks[taskId] = { status: 'FAILED', message: '網路連線錯誤', originalFileName: mediaTasks[taskId] ? mediaTasks[taskId].originalFileName : '未知檔案' };
        }
    }
    
    idsToPoll.forEach(taskId => {
        if (tasks[taskId]) {
            mediaTasks[taskId] = tasks[taskId];
        }
    });

    updateProgressUI();
}


// ----------------------------------------------------
// 上傳照片函式
// ----------------------------------------------------
async function uploadPhoto() {
    if (selectedFiles.length === 0) {
        showMessage('warning', '請先選取檔案');
        return;
    }

    uploadButton.disabled = true;
    uploadButton.innerHTML = '正在提交...'; 

    const targetAlbumId = document.getElementById('targetAlbumSelect').value;
    
    const formData = new FormData();
    selectedFiles.forEach(file => {
        formData.append('photos', file, file.name); 
    });
    formData.append('targetAlbumId', targetAlbumId); 

    try {
        const res = await fetch(`${BACKEND_URL}/api/tasks/submit-upload`, { 
            method: 'POST',
            body: formData,
        });

        const result = await res.json();
        
        if (res.ok) {
            const newTasks = result.taskIds;
            if (newTasks && newTasks.length > 0) {
                
                newTasks.forEach((taskId, index) => {
                    activeTaskIds.push(taskId); 
                    mediaTasks[taskId] = {
                        status: 'PENDING',
                        message: '等待伺服器資源進行媒體處理...',
                        originalFileName: selectedFiles[index] ? selectedFiles[index].name : '未知檔案', 
                    };
                });
                
                selectedFiles = [];
                previewGrid.innerHTML = '';
                emptyState.style.display = 'block';

                showMessage('info', `✅ ${newTasks.length} 個檔案已提交到伺服器背景處理。`);
                
                if (!pollingInterval) {
                    pollingInterval = setInterval(pollTaskStatus, 5000); 
                }
                updateProgressUI(); 
            }
        } else {
            showMessage('error', `提交失敗: ${result.error}`);
            uploadButton.disabled = false;
            uploadButton.innerHTML = `<svg viewBox="0 0 24 24" style="width:20px; height:20px; fill:white;"><path d="M9,16V10H5L12,3L19,10H15V16H9M5,20V18H19V20H5Z" /></svg> <span>上傳</span>`;
        }
    } catch (e) {
        showMessage('error', '上傳發生網路錯誤');
        uploadButton.disabled = false;
        uploadButton.innerHTML = `<svg viewBox="0 0 24 24" style="width:20px; height:20px; fill:white;"><path d="M9,16V10H5L12,3L19,10H15V16H9M5,20V18H19V20H5Z" /></svg> <span>上傳</span>`;
    }
}


// ----------------------------------------------------
// DOMContentLoaded
// ----------------------------------------------------
document.addEventListener('DOMContentLoaded', () => {
    window.uploadPhoto = uploadPhoto;
    window.handleFiles = handleFiles; 
    fetchAlbumsForSelect(); 

    const dropArea = document.getElementById('dropArea');
    const fileInput = document.getElementById('photoFile');

    dropArea.addEventListener('click', () => fileInput.click());
    dropArea.addEventListener('dragover', (e) => {
        e.preventDefault();
        dropArea.classList.add('drag-over');
    });
    dropArea.addEventListener('dragleave', () => {
        dropArea.classList.remove('drag-over');
    });
    dropArea.addEventListener('drop', (e) => {
        e.preventDefault();
        dropArea.classList.remove('drag-over');
        if (e.dataTransfer.files) {
            handleFiles(e.dataTransfer.files);
        }
    });

    fileInput.addEventListener('change', (e) => {
        if (e.target.files) {
            handleFiles(e.target.files);
        }
        e.target.value = ''; 
    });
    
    updateProgressUI();
});