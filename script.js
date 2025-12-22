// script.js (主頁面 - 相簿管理)

const BACKEND_URL = 'https://myphotostorage-backend.zeabur.app'; 

function showMessage(type, content) {
    const messageElement = document.getElementById('message');
    if (!messageElement) return; 
    
    messageElement.className = `message-box ${type}`;
    messageElement.innerHTML = content;
    messageElement.style.display = 'block';
    setTimeout(() => {
        messageElement.style.display = 'none';
    }, 3000);
}

// SVG 圖示 (更名/刪除)
const iconRename = `<svg viewBox="0 0 24 24"><path d="M14.06,9.02L15,9.94L5.92,19H5V18.08L14.06,9.02M17.66,3C17.41,3 17.15,3.1 16.96,3.29L15.13,5.12L18.88,8.87L20.71,7.04C21.1,6.65 21.1,6 20.71,5.63L18.37,3.29C18.17,3.09 17.92,3 17.66,3M14.06,6.19L3,17.25V21H6.75L17.81,9.94L14.06,6.19Z" /></svg>`;
const iconDelete = `<svg viewBox="0 0 24 24"><path d="M19,4H15.5L14.5,3H9.5L8.5,4H5V6H19M6,19A2,2 0 0,0 8,21H16A2,2 0 0,0 18,19V7H6V19Z" /></svg>`;

async function fetchAlbums() {
    const albumListElement = document.getElementById('albumList'); 
    if (!albumListElement) return;

    try {
        albumListElement.innerHTML = '<p style="padding:15px; text-align:center;">載入中...</p>';
        const response = await fetch(`${BACKEND_URL}/api/albums`);
        const albums = await response.json();
        albumListElement.innerHTML = ''; 
        
        if (albums.length === 0) {
            albumListElement.innerHTML = '<p style="padding:15px; text-align:center;">尚未建立任何留影簿。</p>';
            return;
        }

        albums.forEach(album => {
            const albumCard = document.createElement('a'); 
            albumCard.className = 'album-card';
            albumCard.href = `album.html?id=${album._id}&name=${encodeURIComponent(album.name)}`;
            albumCard.target = "_blank"; 

            let actionsHtml = '';
            if (album.name !== '未分類相簿') {
                actionsHtml = `
                    <div class="album-card-actions">
                        <button onclick="showRenameModal('${album._id}', '${album.name}'); event.preventDefault();" title="更名">${iconRename}</button>
                        <button onclick="deleteAlbum('${album._id}', '${album.name}'); event.preventDefault();" title="刪除">${iconDelete}</button>
                    </div>
                `;
            }

            albumCard.innerHTML = `
                <h3>${album.name}</h3>
                <p style="font-size:0.9em; color:#888;">${album.photoCount} 則留影</p>
                ${actionsHtml}
            `;
            albumListElement.appendChild(albumCard);
        });
    } catch (error) {
        console.error('載入相簿失敗:', error);
        showMessage('error', '無法載入列表');
    }
}

async function addNewAlbum() {
    const name = document.getElementById('newAlbumName').value.trim();
    if (!name) return alert('請輸入名稱');

    try {
        const res = await fetch(`${BACKEND_URL}/api/albums`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name })
        });
        if (res.ok) {
            document.getElementById('addAlbumModal').style.display = 'none';
            document.getElementById('newAlbumName').value = ''; 
            fetchAlbums();
        } else {
            alert('建立失敗');
        }
    } catch (e) { alert('網路錯誤'); }
}

function showRenameModal(id, name) {
    document.getElementById('renameAlbumId').value = id;
    document.getElementById('newRenameAlbumName').value = name;
    document.getElementById('renameAlbumModal').style.display = 'block';
}

async function renameAlbum() {
    const id = document.getElementById('renameAlbumId').value;
    const name = document.getElementById('newRenameAlbumName').value.trim();
    if (!name) return alert('名稱不可為空');

    await fetch(`${BACKEND_URL}/api/albums/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }) 
    });
    document.getElementById('renameAlbumModal').style.display = 'none';
    fetchAlbums();
}

async function deleteAlbum(id, name) {
    if (confirm(`刪除「${name}」？照片將移至未分類。`)) {
        await fetch(`${BACKEND_URL}/api/albums/${id}`, { method: 'DELETE' });
        fetchAlbums();
    }
}

window.onclick = function(e) {
    if (e.target.className === 'modal') e.target.style.display = "none";
}

document.addEventListener('DOMContentLoaded', () => {
    window.addNewAlbum = addNewAlbum;
    window.renameAlbum = renameAlbum;
    window.deleteAlbum = deleteAlbum;
    window.showRenameModal = showRenameModal;
    fetchAlbums();
    window.addEventListener('focus', fetchAlbums);
});