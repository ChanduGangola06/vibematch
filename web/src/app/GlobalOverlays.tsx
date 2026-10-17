import { EditProfileModal } from '@/features/profile/EditProfileModal';
import { ProfileDrawer } from '@/features/profile/ProfileDrawer';
import { ShopModal } from '@/features/shop/ShopModal';
import { VipModal } from '@/features/shop/VipModal';
import { useUi } from './UiProvider';

/** Overlays that can be opened from anywhere via `useUi()`. */
export function GlobalOverlays() {
  const ui = useUi();
  return (
    <>
      <ShopModal open={ui.isOpen('shop')} onClose={() => ui.close('shop')} />
      <VipModal open={ui.isOpen('vip')} onClose={() => ui.close('vip')} />
      <ProfileDrawer open={ui.isOpen('drawer')} onClose={() => ui.close('drawer')} />
      <EditProfileModal open={ui.isOpen('editProfile')} onClose={() => ui.close('editProfile')} />
    </>
  );
}
