// auth-check.js - 前端登入狀態檢查腳本
// 此腳本需在所有受保護頁面的最前面載入

(async function checkAuth() {
    try {
        const response = await fetch('/api/auth/check');
        
        if (!response.ok) {
            // 未登入，重導向到登入頁面
            const currentPath = window.location.pathname + window.location.search;
            window.location.href = `/login.html?redirect=${encodeURIComponent(currentPath)}`;
        }
        // 已登入，繼續載入頁面
    } catch (error) {
        console.error('認證檢查失敗:', error);
        // 網路錯誤，為安全起見也跳轉到登入頁
        window.location.href = '/login.html';
    }
})();

// 提供登出功能
async function logout() {
    try {
        const response = await fetch('/api/auth/logout', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            }
        });
        
        if (response.ok) {
            // 登出成功，跳轉到登入頁
            window.location.href = '/login.html';
        } else {
            alert('登出失敗，請重試');
        }
    } catch (error) {
        console.error('登出錯誤:', error);
        alert('登出失敗：網路連線異常');
    }
}